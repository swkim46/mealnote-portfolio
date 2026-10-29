import copy
from datetime import date, datetime, timezone
import unittest

from update import readme_text, validate, yesterday


class MetricRules(unittest.TestCase):
    def setUp(self):
        self.rows = [
            {'date': '2026-10-27', 'members_total': 3, 'active_members': 2, 'meals_total': 5},
            {'date': '2026-10-28', 'members_total': 4, 'active_members': 0, 'meals_total': 5},
            {'date': '2026-10-29', 'members_total': 4, 'active_members': 1, 'meals_total': 8},
        ]
        self.through = date(2026, 10, 29)

    def test_korean_midnight(self):
        self.assertEqual(yesterday(datetime(2026, 10, 29, 14, 59, tzinfo=timezone.utc)), date(2026, 10, 28))
        self.assertEqual(yesterday(datetime(2026, 10, 29, 15, 0, tzinfo=timezone.utc)), date(2026, 10, 29))

    def test_inactive_day_is_zero_and_not_cumulative(self):
        validate(self.rows, self.through)
        self.assertEqual([r['active_members'] for r in self.rows], [2, 0, 1])

    def test_rejects_private_fields(self):
        for key in ('nickname', 'member_id', 'food'):
            rows = copy.deepcopy(self.rows)
            rows[0][key] = 'must not be published'
            with self.assertRaises(ValueError):
                validate(rows, self.through)

    def test_rejects_missing_duplicate_and_unfinished_days(self):
        for rows in ([], self.rows[::2], self.rows + [self.rows[-1]], self.rows[:-1]):
            with self.assertRaises(ValueError):
                validate(rows, self.through)
        with self.assertRaises(ValueError):
            validate(self.rows, date(2026, 10, 28))

    def test_rejects_invalid_counts(self):
        for field, value in [('active_members', 5), ('active_members', -1), ('members_total', True), ('meals_total', 4)]:
            rows = copy.deepcopy(self.rows)
            rows[1][field] = value
            with self.assertRaises(ValueError):
                validate(rows, self.through)

    def test_only_marked_readme_sections_change(self):
        before = ('Intro stays.\n<!-- usage-metrics:start -->old<!-- usage-metrics:end -->\n'
                  'Design stays.\n<!-- usage-metrics-en:start -->old<!-- usage-metrics-en:end -->\nEnd stays.')
        result = readme_text(before, self.rows)
        self.assertIn('Intro stays.', result)
        self.assertIn('Design stays.', result)
        self.assertIn('End stays.', result)
        self.assertIn('당일 활성 회원 1명', result)
        self.assertIn('누적 식단 기록 8건', result)
        self.assertEqual(readme_text(result, self.rows), result)

    def test_missing_markers_fail_instead_of_rewriting_prose(self):
        with self.assertRaises(ValueError):
            readme_text('Unrelated README', self.rows)


if __name__ == '__main__':
    unittest.main()
