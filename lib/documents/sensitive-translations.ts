// The sensitive folder names in the app's other six languages.
//
// `SENSITIVE_CATEGORIES` (lib/documents/sensitivity.ts) is English, and the
// folder box is not: the Dutch Documents form suggests "School, Financiën,
// Vakantie 2025" for the English "School, Finances, Vacation 2025". These are
// DERIVED, not invented: every entry is what one of the six catalogues
// (lib/i18n/messages) calls a one-word English label the English rule already
// calls sensitive — "Finances", "Medical", "Insurance", "Passport", "Banking",
// "Retirement" … — lowercased, accents dropped (Financiën → financien), non
// letters to one space. tests/a-sensitive-folder-is-sensitive-in-every-language-
// the-app-speaks.test.ts re-derives them from the catalogues: it fails, naming
// the label, when a translation is missing here, and when an entry here is not
// a translation the catalogues give.
//
// The database does not know these words: `public.is_sensitive_document` (0312)
// reads the ASCII English vocabulary only. So a folder that is sensitive only in
// translation is filed with `is_secure` (`needsSecureFlag`), which the database
// does read. Teaching the SQL rule these words is a schema change.

/** One-word translations, folded. One trailing "s" still reaches the word, as in English. */
export const SENSITIVE_TRANSLATIONS: ReadonlySet<string> = new Set([
  'arztpraxis', 'assicurazione', 'assicurazioni', 'assurance', 'assurances', 'ausweis', 'banca',
  'bankgeschafte', 'bankzaken', 'banque', 'belegging', 'dni', 'financas', 'financieel',
  'financien', 'finanzas', 'finanze', 'finanzen', 'fuhrerschein', 'fuhrerscheine', 'gesundheit',
  'gezondheid', 'inversion', 'investimento', 'investissement', 'investition', 'jubilacion',
  'juridico', 'juridique', 'juridisch', 'kranken', 'legale', 'licenca', 'licencia', 'licencias',
  'licentie', 'licenza', 'lizenz', 'medico', 'medisch', 'medizin', 'medizinisch', 'medizinisches',
  'pasaporte', 'pasaportes', 'paspoort', 'paspoorten', 'passaporte', 'passaportes', 'passaporti',
  'passaporto', 'passeport', 'passeports', 'patente', 'patenti', 'pensioen', 'pensione', 'permis',
  'permisos', 'rechtliches', 'reisepass', 'reisepasse', 'retraite', 'rijbewijs', 'rijbewijzen',
  'ruhestand', 'salud', 'salute', 'sante', 'saude', 'seguro', 'seguros', 'versicherung',
  'versicherungen', 'verzekering', 'verzekeringen', 'zorg',
]);

/** Translations of more than one word, folded; matched anywhere in the folded folder name. */
export const SENSITIVE_TRANSLATED_PHRASES: readonly string[] = [
  'carta de conducao', 'cartao de cidadao', 'cartas de conducao', 'documento d identita',
  'mentions legales', 'note legali', 'piece d identite', 'servicos bancarios',
];

/**
 * Translations the catalogues give that also name something ordinary in a
 * language a family types, so a whole class of everyday folders would become
 * adults-only. Kept out on purpose, and pinned as ordinary by the test.
 *   anlage    — de "Investment", but also "attachment" / "enclosure" (Anlagen)
 *   placement — fr "Investment", but also a school or job placement
 *   reforma   — pt "Retirement", but es "renovation"
 */
export const SENSITIVE_TRANSLATION_EXCLUSIONS: readonly string[] = ['anlage', 'placement', 'reforma'];
