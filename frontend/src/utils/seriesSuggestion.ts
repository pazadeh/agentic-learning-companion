/** Lightweight, deterministic signals for offering a multi-part lecture series.
 *
 * These only decide whether to *offer* a series. The app never converts a request
 * on its own: the learner always chooses between one lecture and a series draft.
 */

const NUMBER_WORDS = '(?:\\d+|two|three|four|five|six|seven|eight)';

// "4 lectures", "four 30-minute lectures", "4 x 30 min episodes", "a lecture series",
// "multi-part", "a course on ...".
const EXPLICIT_SERIES_PATTERNS: RegExp[] = [
  new RegExp(
    `\\b${NUMBER_WORDS}\\s*(?:[x×*]\\s*)?(?:\\d+\\s*[- ]?\\s*min(?:ute)?s?\\s+)?(?:lectures|episodes|parts|sessions|lessons)\\b`,
    'i'
  ),
  /\b(?:lecture|audio|podcast)\s+series\b/i,
  /\bmulti[- ]?part\b/i,
  /\b(?:a|an|full|short)\s+course\b/i,
];

// Topics whose scope usually exceeds what one lecture can cover well.
const BROAD_TOPIC_PATTERNS: RegExp[] = [
  /\bbook\b/i,
  /\bchapters?\b/i,
  /\bcomprehensive\b/i,
  /\bin[- ]depth\b/i,
  /\bdeep[- ]dive\b/i,
  /\beverything about\b/i,
  /\bcomplete guide\b/i,
  /\bhistory of\b/i,
  /\bfrom (?:the )?basics\b/i,
  /\bfundamentals of\b/i,
  /\bmaster(?:ing|y)?\b/i,
];

/** True when the learner explicitly asks for several lectures. */
export function isExplicitSeriesRequest(text: string): boolean {
  return EXPLICIT_SERIES_PATTERNS.some((pattern) => pattern.test(text));
}

/** True when a topic is broad enough that a series is worth offering afterwards. */
export function hasSeriesPotential(text: string): boolean {
  return isExplicitSeriesRequest(text) || BROAD_TOPIC_PATTERNS.some((pattern) => pattern.test(text));
}
