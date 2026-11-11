// Dietary suitability assessment. A dish is never treated as vegetarian just because its name sounds vegetarian.
import type { Diet, DietStatus } from '../../shared/types.ts';

const MEAT = ['chicken', 'beef', 'pork', 'lamb', 'veal', 'duck', 'bacon', 'ham', 'sausage', 'chorizo', 'salami', 'prosciutto', 'pancetta', 'mince', 'meatball', 'turkey', 'goose', 'rabbit', 'venison', 'foie gras', 'guanciale', 'speck', 'mortadella', 'boudin', 'andouille', 'jamón', 'jamon'];
const FISH = ['fish', 'anchov', 'tuna', 'salmon', 'cod', 'shrimp', 'prawn', 'crab', 'lobster', 'mussel', 'clam', 'oyster', 'squid', 'octopus', 'scallop', 'sardine', 'bonito', 'katsuobushi', 'dashi', 'fish sauce', 'nam pla', 'nuoc mam', 'shrimp paste', 'belacan', 'oyster sauce', 'caviar', 'roe', 'eel', 'bacalhau', 'bacalao'];
const HIDDEN_ANIMAL = ['chicken stock', 'beef stock', 'meat stock', 'bone broth', 'chicken broth', 'beef broth', 'lard', 'suet', 'gelatin', 'gelatine', 'worcestershire', 'tallow', 'schmaltz', 'animal rennet', 'fond de veau'];
const NON_VEGAN = ['cheese', 'milk', 'cream', 'butter', 'egg', 'yogurt', 'yoghurt', 'honey', 'ghee', 'paneer', 'mayonnaise', 'aioli', 'crème', 'creme', 'feta', 'mozzarella', 'parmesan', 'parmigiano'];
/** Dishes whose traditional preparation commonly uses meat or fish stock/sauce even when no meat is visible. */
const TRADITIONALLY_RISKY = ['french onion soup', 'soupe à l\'oignon', 'risotto', 'ramen', 'pho', 'miso soup', 'caesar', 'pad thai', 'kimchi', 'tom yum', 'paella', 'gravy', 'refried beans', 'minestrone', 'gazpacho', 'ribollita', 'stoemp', 'carbonnade', 'waterzooi', 'laksa', 'poutine', 'fried rice', 'mapo tofu', 'som tam', 'green curry', 'red curry', 'massaman', 'parmesan', 'pesto', 'tortellini', 'pierogi'];

export interface DishEvidence {
  name: string;
  /** Menu/description text from the cited source. */
  sourceText: string;
  /** Explicit labelling seen in the source, e.g. menu marks (V), (VG), 'vegetarian', 'vegan'. */
  labelled?: 'vegetarian' | 'vegan' | null;
  sourceUrl?: string | null;
}

export interface DietAssessment { status: DietStatus; reasons: string[] }

function hits(text: string, list: string[]): string[] {
  const t = ' ' + text.toLowerCase() + ' ';
  return list.filter((w) => {
    const re = new RegExp(`(^|[^a-zà-ÿ])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');
    if (!re.test(t)) return false;
    // ignore negated mentions such as "no fish sauce", "without anchovies", "vegetarian fish sauce"
    const neg = new RegExp(`(no|without|sans|vegan|vegetarian|veggie|plant-based|mock|faux)\\s+${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');
    return !neg.test(t);
  });
}

export function assessDish(e: DishEvidence, diet: Diet): DietAssessment {
  if (diet === 'none') return { status: 'confirmed', reasons: ['No dietary restriction set.'] };
  const text = `${e.name}. ${e.sourceText}`;
  const reasons: string[] = [];
  const meat = hits(text, MEAT); const fish = hits(text, FISH); const hidden = hits(text, HIDDEN_ANIMAL);
  const dairyEgg = hits(text, NON_VEGAN);
  if (meat.length) return { status: 'not_suitable', reasons: [`Source mentions ${meat.join(', ')}.`] };
  if (diet !== 'pescatarian' && fish.length) return { status: 'not_suitable', reasons: [`Source mentions ${fish.join(', ')}.`] };
  if (hidden.length) return { status: 'not_suitable', reasons: [`Source mentions ${hidden.join(', ')}.`] };
  if (diet === 'vegan' && dairyEgg.length && e.labelled !== 'vegan') return { status: 'not_suitable', reasons: [`Source mentions ${dairyEgg.join(', ')}.`] };

  const risky = TRADITIONALLY_RISKY.filter((r) => text.toLowerCase().includes(r));
  const labelOk = diet === 'vegan' ? e.labelled === 'vegan' : e.labelled === 'vegetarian' || e.labelled === 'vegan';
  if (labelOk && e.sourceUrl) {
    if (risky.length) reasons.push(`Labelled ${e.labelled} by the source; traditionally ${risky.join(', ')} can contain animal stock, so confirm with staff.`);
    else reasons.push(`Labelled ${e.labelled} in the cited source.`);
    return { status: risky.length ? 'likely' : 'confirmed', reasons };
  }
  if (risky.length) return { status: 'uncertain', reasons: [`${risky.join(', ')} is often made with meat/fish stock, cheese with animal rennet or fish sauce; not confirmed ${diet} by the source.`] };
  if (diet === 'vegetarian' && /parmesan|parmigiano|grana padano|pecorino|gorgonzola/i.test(text)) {
    return { status: 'uncertain', reasons: ['Traditional hard cheeses use animal rennet.'] };
  }
  return { status: 'uncertain', reasons: [`Not explicitly marked ${diet} in the source; ingredients such as stocks and sauces are unknown.`] };
}

export function venueDietNote(statuses: DietStatus[], diet: Diet): string {
  if (diet === 'none') return '';
  const confirmed = statuses.filter((s) => s === 'confirmed').length;
  if (confirmed) return `${confirmed} dish(es) confirmed ${diet} by the cited menu.`;
  if (statuses.some((s) => s === 'likely')) return `Dishes are labelled ${diet}; confirm stocks and sauces with staff.`;
  return `No dish could be confirmed ${diet} from current sources; ask staff before ordering.`;
}
