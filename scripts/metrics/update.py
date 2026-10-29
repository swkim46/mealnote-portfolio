"""Publish aggregate-only daily usage charts. Database credentials stay in env."""
from __future__ import annotations

import argparse
from datetime import date, datetime, timedelta
import io
import json
import os
from pathlib import Path
import re
import sys
import tempfile
from zoneinfo import ZoneInfo

KST = ZoneInfo('Asia/Seoul')
FIELDS = {'date', 'members_total', 'active_members', 'meals_total'}
ROOT = Path(__file__).resolve().parents[2]


def yesterday(now: datetime | None = None) -> date:
    return (now or datetime.now(KST)).astimezone(KST).date() - timedelta(days=1)


def fetch_rows() -> list[dict]:
    import psycopg
    from psycopg.rows import dict_row

    url = os.environ.get('METRICS_DATABASE_URL')
    if not url:
        raise ValueError('METRICS_DATABASE_URL is missing')
    # Never include the connection string, host, or raw database errors in logs.
    try:
        # libpq builds differ in how they handle non-ASCII certificate paths.
        with tempfile.TemporaryDirectory(prefix='mealnote-ca-') as tmp:
            ca = Path(tmp) / 'root.crt'
            ca.write_bytes(Path(__file__).with_name('supabase-ca.crt').read_bytes())
            with psycopg.connect(url, connect_timeout=20, row_factory=dict_row,
                                 sslmode='verify-full', sslrootcert=str(ca),
                                 options='-c default_transaction_read_only=on -c statement_timeout=15000') as conn:
                rows = conn.execute('select date, members_total, active_members, meals_total from portfolio_metrics.daily_usage order by date').fetchall()
        return [{**row, 'date': row['date'].isoformat()} for row in rows]
    except psycopg.Error:
        raise RuntimeError('Metrics query failed; existing published files are preserved.') from None


def validate(rows: list[dict], through: date) -> None:
    if not isinstance(rows, list) or not rows:
        raise ValueError('Empty metrics response')
    previous = None
    for row in rows:
        if not isinstance(row, dict) or set(row) != FIELDS:
            raise ValueError('Unexpected fields in metrics response')
        day = date.fromisoformat(row['date'])
        if row['date'] != day.isoformat() or day > through:
            raise ValueError('Invalid or unfinished reporting date')
        for key in FIELDS - {'date'}:
            if type(row[key]) is not int or row[key] < 0:
                raise ValueError('Invalid count')
        if previous:
            if day != date.fromisoformat(previous['date']) + timedelta(days=1):
                raise ValueError('Missing or duplicate reporting day')
            if any(row[k] < previous[k] for k in ('members_total', 'meals_total')):
                raise ValueError('Cumulative series decreases within a snapshot')
        new_meals = row['meals_total'] - (previous['meals_total'] if previous else 0)
        if row['active_members'] > min(row['members_total'], new_meals):
            raise ValueError('Active members exceed members or meals written that day')
        previous = row
    if rows[-1]['date'] != through.isoformat():
        raise ValueError('Metrics do not cover the last completed Korean day')


def replace_block(text: str, name: str, content: str) -> str:
    start, end = f'<!-- {name}:start -->', f'<!-- {name}:end -->'
    if text.count(start) != 1 or text.count(end) != 1:
        raise ValueError(f'Expected exactly one {name} block')
    return re.sub(re.escape(start) + r'.*?' + re.escape(end),
                  lambda _: f'{start}\n{content}\n{end}', text, flags=re.S)


def readme_text(text: str, rows: list[dict]) -> str:
    latest = rows[-1]
    day = date.fromisoformat(latest['date'])
    alt = (f"식단노트 사용 추이. {day.month}월 {day.day}일 기준 가입 회원 {latest['members_total']}명, "
           f"당일 활성 회원 {latest['active_members']}명, 누적 식단 기록 {latest['meals_total']}건")
    content = f'''<picture>
  <source media="(max-width: 600px)" srcset="docs/images/usage-mobile.svg">
  <img src="docs/images/usage.svg" alt="{alt}" width="1100">
</picture>

{day.year}년 {day.month}월 {day.day}일까지의 기록입니다. 활성 회원은 그날 식단을 한 번 이상 작성한 회원이며, 가입 회원과 식단 기록은 누적입니다. 테스트 계정은 제외하고, 매일 전날까지 갱신합니다. [집계 기준](docs/reference/사용_현황_집계.md)'''
    text = replace_block(text, 'usage-metrics', content)
    english = (f"Through {day.strftime('%B')} {day.day}, {day.year} (KST), the app had "
               f"{latest['members_total']} registered members and {latest['meals_total']} meal records. "
               f"On that day, {latest['active_members']} members logged at least one meal. "
               'Test accounts are excluded; the charts update daily after the Korean day ends.')
    return replace_block(text, 'usage-metrics-en', english)


def render(rows: list[dict], *, mobile: bool = False) -> bytes:
    import matplotlib
    matplotlib.use('Agg')
    from matplotlib import font_manager, pyplot as plt
    from matplotlib.ticker import MaxNLocator

    names = {f.name for f in font_manager.fontManager.ttflist}
    font = next((x for x in ('NanumGothic', 'Noto Sans CJK KR', 'Apple SD Gothic Neo', 'AppleGothic') if x in names), None)
    if not font:
        raise RuntimeError('A Korean font is required')
    plt.rcParams.update({'font.family': font, 'svg.fonttype': 'path',
                         'svg.hashsalt': 'mealnote-daily-usage', 'axes.unicode_minus': False})
    # One shared date range; each metric has its own unit and zero baseline.
    rows = rows[-90:]
    series = [
        ('가입 회원', '누적', 'members_total', '명', '#c55200'),
        ('활성 회원', '하루 동안 기록한 회원', 'active_members', '명', '#2563eb'),
        ('식단 기록', '누적', 'meals_total', '건', '#15803d'),
    ]
    fig, axes = plt.subplots(3 if mobile else 1, 1 if mobile else 3,
                             figsize=(5.2, 10.8) if mobile else (13.2, 4.2))
    fig.set_facecolor('white')
    fig.subplots_adjust(left=.13 if mobile else .055, right=.96 if mobile else .98,
                        top=.86 if mobile else .64, bottom=.07 if mobile else .17,
                        hspace=1.15 if mobile else .2, wspace=.36)
    n = len(rows)
    tick_positions = list(range(n)) if n <= 7 else sorted({round(i * (n - 1) / 3) for i in range(4)})
    for ax, (title, note, key, unit, color) in zip(axes.flat, series):
        values = [r[key] for r in rows]
        ax.text(0, 1.52 if mobile else 1.62, title, transform=ax.transAxes,
                fontsize=17, fontweight='bold', color='#171717')
        ax.text(0, 1.32 if mobile else 1.40, note, transform=ax.transAxes,
                fontsize=10, color='#666666')
        ax.text(0, 1.06 if mobile else 1.10, f'{values[-1]:,}{unit}', transform=ax.transAxes,
                fontsize=29, fontweight='bold', color=color)
        ax.plot(range(n), values, color=color, linewidth=2.4,
                marker='o' if n <= 14 else None, markersize=4, zorder=3)
        ax.scatter([n - 1], [values[-1]], color=color, s=27, zorder=4)
        ax.set_xlim(-.2, max(n - 1, .8) + .2)
        ax.set_ylim(0, max(1, max(values) * 1.18))
        ax.yaxis.set_major_locator(MaxNLocator(nbins=3, integer=True, min_n_ticks=2))
        ax.set_xticks(tick_positions, [date.fromisoformat(rows[i]['date']).strftime('%m/%d') for i in tick_positions])
        ax.tick_params(axis='both', which='both', length=0, labelsize=10, colors='#666666', pad=8)
        ax.grid(axis='y', color='#e5e7eb', linewidth=.7, zorder=0)
        for spine in ax.spines.values():
            spine.set_visible(False)
    buf = io.BytesIO()
    fig.savefig(buf, format='svg', facecolor='white', metadata={'Date': None, 'Creator': 'Mealnote daily usage'})
    plt.close(fig)
    svg = buf.getvalue().decode()
    # Comma-separated SVG coordinates avoid false phone-number matches in glyph paths.
    svg = re.sub(r'\bd="([^"]+)"', lambda m: 'd="' + re.sub(r'(?<=[0-9.])\s+(?=[+-]?\d)', ',', m.group(1)) + '"', svg)
    svg = "\n".join(line.rstrip() for line in svg.splitlines()) + "\n"
    return svg.encode()


def publish(root: Path, rows: list[dict], through: date) -> None:
    validate(rows, through)
    rows = [{key: row[key] for key in ('date', 'members_total', 'active_members', 'meals_total')} for row in rows]
    readme = root / 'README.md'
    updated_readme = readme_text(readme.read_text(), rows)
    # Validate and render everything before replacing any output.
    outputs = {
        root / 'docs/images/usage.svg': render(rows),
        root / 'docs/images/usage-mobile.svg': render(rows, mobile=True),
        root / 'docs/data/usage.json': (json.dumps({'schema_version': 1, 'timezone': 'Asia/Seoul',
            'through': through.isoformat(), 'series': rows}, ensure_ascii=False, indent=2) + '\n').encode(),
        readme: updated_readme.encode(),
    }
    for path, data in outputs.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(path.name + '.tmp')
        tmp.write_bytes(data)
        tmp.replace(path)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', type=Path, help='Render previously saved aggregate JSON without a database connection')
    parser.add_argument('--root', type=Path, default=ROOT)
    args = parser.parse_args()
    rows = json.loads(args.input.read_text())['series'] if args.input else fetch_rows()
    through = yesterday()
    publish(args.root, rows, through)
    print(f'Updated {len(rows)} daily aggregate rows through {through.isoformat()} (KST).')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, RuntimeError) as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(1)
