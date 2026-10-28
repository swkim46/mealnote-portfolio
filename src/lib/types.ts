export type Role = 'member' | 'trainer';

export const MEAL_TYPES = ['아침', '점심', '저녁', '간식'] as const;
export type MealType = (typeof MEAL_TYPES)[number];

export type AccountRole = Role | 'admin';

export interface Profile {
  id: string;
  nickname: string;
  role: AccountRole;
}

export interface Comment {
  id: string;
  meal_id: string;
  author_role: Role;
  body: string;
  created_at: string;
}

export interface Meal {
  id: string;
  member_id: string;
  eaten_on: string; // YYYY-MM-DD
  eaten_at: string; // HH:MM
  meal_type: MealType;
  food: string;
  note: string;
  photo_path: string | null;
  created_at: string;
  reviewed_at: string | null;
  member_seen_at: string;
  note_updated_at: string;
  member_msg_at: string | null;
  trainer_msg_at: string | null;
  /** 트레이너 평가 1~3(src/lib/rating.ts), 없으면 null */
  rating: 1 | 2 | 3 | null;
  rated_at: string | null;
  comments: Comment[];
  member_nickname: string;
}

export interface MealInput {
  eaten_on: string;
  eaten_at: string;
  meal_type: MealType;
  food: string;
  note: string;
}

export interface InbodyRecord {
  id: string;
  member_id: string;
  measured_on: string; // YYYY-MM-DD
  weight_kg: number;
  smm_kg: number | null;
  pbf_pct: number | null;
  source: 'ocr' | 'manual';
}

export interface InbodyInput {
  measured_on: string;
  weight_kg: number;
  smm_kg: number | null;
  pbf_pct: number | null;
  source: 'ocr' | 'manual';
}
