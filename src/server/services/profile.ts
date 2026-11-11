import type { AppContext } from '../context.ts';
import { HttpError } from '../http/core.ts';
import { isValidTimeZone } from '../domain/time.ts';
import type { Place } from '../../shared/types.ts';

export interface ProfileInput {
  displayName?: string;
  homePlace?: Place | null;
  departureAirports?: { iata: string; name: string; cityName?: string }[];
  timeZone?: string;
  currency?: string;
  contactEmailOptIn?: boolean;
  diet?: 'none' | 'vegetarian' | 'vegan' | 'pescatarian';
  allergies?: string[];
  dietaryNotes?: string;
  budgetTotal?: number | null;
  pace?: 'relaxed' | 'moderate' | 'packed';
  interests?: string[];
  hikingExperience?: 'none' | 'beginner' | 'intermediate' | 'experienced';
  hikingDifficulty?: 'easy' | 'moderate' | 'hard';
  accommodationPref?: 'any' | 'private' | 'dorm';
  checkedBag?: boolean;
  wakeTime?: string;
  prepMinutes?: number;
  onboardingComplete?: boolean;
}

const COLS: Record<string, string> = {
  homePlace: 'home_place', departureAirports: 'departure_airports', timeZone: 'time_zone', currency: 'currency', contactEmailOptIn: 'contact_email_opt_in',
  diet: 'diet', allergies: 'allergies', dietaryNotes: 'dietary_notes', budgetTotal: 'budget_total', pace: 'pace', interests: 'interests',
  hikingExperience: 'hiking_experience', hikingDifficulty: 'hiking_difficulty', accommodationPref: 'accommodation_pref', checkedBag: 'checked_bag',
  wakeTime: 'wake_time', prepMinutes: 'prep_minutes', onboardingComplete: 'onboarding_complete',
};
const JSON_COLS = new Set(['homePlace', 'departureAirports', 'allergies', 'interests']);

export function profileFromRow(r: any) {
  return {
    homePlace: r.home_place as Place | null, departureAirports: r.departure_airports as { iata: string; name: string; cityName?: string }[], timeZone: r.time_zone as string, currency: r.currency as string, contactEmailOptIn: r.contact_email_opt_in as boolean,
    diet: r.diet as 'none' | 'vegetarian' | 'vegan' | 'pescatarian', allergies: r.allergies as string[], dietaryNotes: r.dietary_notes as string, budgetTotal: r.budget_total === null ? null : Number(r.budget_total), pace: r.pace as 'relaxed' | 'moderate' | 'packed',
    interests: r.interests as string[], hikingExperience: r.hiking_experience as 'none' | 'beginner' | 'intermediate' | 'experienced', hikingDifficulty: r.hiking_difficulty as string, accommodationPref: r.accommodation_pref as 'any' | 'private' | 'dorm',
    checkedBag: r.checked_bag as boolean, wakeTime: r.wake_time as string, prepMinutes: r.prep_minutes as number, valueOfTimePerHour: Number(r.value_of_time_per_hour), onboardingComplete: r.onboarding_complete as boolean,
  };
}
export type Profile = ReturnType<typeof profileFromRow>;

export async function getProfile(ctx: AppContext, userId: string): Promise<Profile> {
  const r = await ctx.db.query('SELECT * FROM profiles WHERE user_id=$1', [userId]);
  if (!r.rows.length) throw new HttpError(404, 'not_found', 'Profile not found');
  return profileFromRow(r.rows[0]);
}

export async function updateProfile(ctx: AppContext, userId: string, input: ProfileInput) {
  if (input.timeZone && !isValidTimeZone(input.timeZone)) throw new HttpError(400, 'invalid_input', 'Unknown time zone');
  if (input.currency && !/^[A-Z]{3}$/.test(input.currency)) throw new HttpError(400, 'invalid_input', 'Currency must be an ISO code such as EUR');
  const sets: string[] = []; const vals: unknown[] = [userId];
  for (const [k, col] of Object.entries(COLS)) {
    const val = (input as Record<string, unknown>)[k];
    if (val === undefined) continue;
    vals.push(JSON_COLS.has(k) && val !== null ? JSON.stringify(val) : val);
    sets.push(`${col}=$${vals.length}`);
  }
  await ctx.db.tx(async (q) => {
    if (sets.length) await q.query(`UPDATE profiles SET ${sets.join(', ')}, updated_at=now() WHERE user_id=$1`, vals);
    if (input.displayName !== undefined) await q.query('UPDATE users SET display_name=$2, updated_at=now() WHERE id=$1', [userId, input.displayName]);
  });
  return getProfile(ctx, userId);
}

/** Searchable place dropdown backed by the flight provider's place database (cities and airports worldwide). */
export async function searchPlaces(ctx: AppContext, query: string, near?: { lat: number; lng: number }) {
  if (!query && !near) return [];
  return ctx.providers.flights.searchPlaces(query, near ? { lat: near.lat, lng: near.lng, radiusM: 100000 } : undefined);
}
