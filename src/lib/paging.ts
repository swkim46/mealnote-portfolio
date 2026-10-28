// 서버는 한 번에 최대 1,000건만 돌려준다(Supabase max_rows). 그보다 많을 수 있는 조회는 나눠 받는다.
// Codex 리뷰 P2(4): 페이지 없이 받으면 1,000건을 넘는 순간 미확인 기록이 조용히 빠졌다.
export const PAGE_SIZE = 500; // 서버 상한보다 작아야 '마지막 페이지' 판정이 맞다

export async function fetchAllPages<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await page(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    out.push(...(data ?? []));
    if (!data || data.length < PAGE_SIZE) return out;
  }
}
