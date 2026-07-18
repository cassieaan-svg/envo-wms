// Explicit commodity → national CRRF row map. Keys are the exact commodity name
// as stored in the DB; values are the national template row the commodity reports
// on, written as "<name>|<unit-or-pack>" — the same key buildCrrfRows derives from
// each template row.
//
// This replaces fuzzy text matching, which silently mis-placed lookalike names
// (e.g. "Visitec CD4 Test Kits" landed on the "Recency Test Kit" row). Row LABELS
// on the printed form always come from the template, never from these DB names — a
// commodity's numbers simply report under its official national name.
//
// Commodities not on the national list (e.g. TAF, Cabotegravir, Gene Xpert) are
// intentionally absent here; the CRRF appends them as extra rows only where a
// facility actually stocks them.
export const CRRF_ALIASES = {
  // ── Pharmacy · ARVs & OIs ──────────────────────────────────────────────
  'ABC/3TC 600/300mg (30 tabs)':      'ABC/3TC (600/300mg)|30 tabs',
  'ABC/3TC 120/60mg (30 tabs)':       'ABC/3TC ( 120/60mg )|30 tabs',
  'ABC/3TC 120/60mg (60 tabs)':       'ABC/3TC (120/60mg)|60 tabs',
  'ABC/3TC/DTG 60/30/5mg':            'ABC/3TC/DTG (60/30/5mg)|180 tabs',
  'AZT/3TC 300/150mg (60 tabs)':      'AZT/3TC (300/150 mg)|60 tabs',
  'AZT/3TC (60/30mg)':                'AZT/3TC (60/30mg)|60 tabs',
  'TDF/3TC 300/300mg (30 tabs)':      'TDF/3TC(300/300 mg)|30 tabs',
  'TDF/3TC/DTG 300/300/50mg (90 tabs)': 'TDF/3TC/DtG(300/300/50mg)|90 tab',
  'DTG 10mg (90 tabs)':               'DTG 10mg|90 tabs',
  'DTG 50mg (30 tabs)':               'Dolutegravir DTG 50mg|30 tabs',
  'ATV/r 300/100mg (30 tabs)':        'Atazanavir/Ritonavir (ATV/r) 300/100mg|30 tabs',
  'Lopinavir/Ritonavir (100/25mg)':   'Lopinavir/Ritonavir (LPV/r) 100/25mg|60 tabs',
  'AZT 50mg/5ml (240ml)':             'Zidovudine AZT 50mg/5mL|240 mL',
  'NVP 50mg/5ml (100ml)':             'Nevirapine NVP 50mg/5mL|100 mL',
  'INH 100mg (kits)':                 'Isoniazid (INH) 100mg|kits',
  'INH 300mg (kits)':                 'Isoniazid (INH) 300mg|kits',
  'Cotrimoxazole 120mg (tabs)':       'Co-trimoxazole 120mg|tabs',
  'Cotrimoxazole 960mg (tabs)':       'Co-trimoxazole 960mg|tabs',
  'Fluconazole 200mg (caps)':         'Fluonazole 200mg|tab',

  // ── Pharmacy · Condoms & Lubricants ────────────────────────────────────
  'Male Condom (pcs)':                'Male Condom|1 piece',
  'Female Condom (pcs)':              'Female condom|1 piece',
  'Lubricant':                        'Lubricant|1 piece',

  // ── Lab · HIV RTKs & DBS ───────────────────────────────────────────────
  'Alere Determine':                  'DETERMINE|Test',
  'Unigold':                          'UNIGOLD|Test',
  'Stat-Pak':                         'STAT-PAK|Test',
  'Standard Q HIV 1/2 Ab 3-Line Test': 'STANDARD Q|Test',
  'HIV Self-Test Kit (OraQuick)':     'HIV SELF TEST (ORAL BASED)|Test',
  'DBS Kits':                         'DBS TEST COLLECTION BUNDLES|Test',
  'Cryptococcal Antigen Lateral Flow Assay (CrAg-LFA)': 'Cryptococcal Antigen Lateral Flow Assay (CrAg- LFA)|Test',
  'HIV Syphilis Dual Test Kit':       'HIV syphilis dual test kit|Test',
  'Urine TB LF-LAM':                  'Urine TB LF-LAM|Test',
  'Hepatitis B':                      'Hepatitis B|Test',
  'Hepatitis C':                      'Hepatitis C|Test',
  'Urinalysis Strip':                 'Urinalysis|Test',

  // ── Lab · CD4 ──────────────────────────────────────────────────────────
  'Visitec CD4 Test Kits':            'VISITECT CD4 Advanced disease|1 Tests',
  'mPima Cartridges':                 'Pima CD4 Catridge Kit,100 Tests|1 Test',
}
