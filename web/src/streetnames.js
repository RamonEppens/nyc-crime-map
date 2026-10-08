// Street-name key (clave): the ONE normalization used for official street names (pipeline,
// pipeline/scripts/streetnames.py) and for what people type. Both must give the same key for
// every case in config/street_name_cases.json (tested on both sides).
const ORDINAL_WORDS = {
  FIRST: '1', SECOND: '2', THIRD: '3', FOURTH: '4', FIFTH: '5', SIXTH: '6',
  SEVENTH: '7', EIGHTH: '8', NINTH: '9', TENTH: '10', ELEVENTH: '11', TWELFTH: '12',
};
const ABBREV = {
  AVE: 'AVENUE', AV: 'AVENUE', AVENU: 'AVENUE', BLVD: 'BOULEVARD', BL: 'BOULEVARD',
  PL: 'PLACE', PKWY: 'PARKWAY', PKY: 'PARKWAY', EXPY: 'EXPRESSWAY', EXPWY: 'EXPRESSWAY',
  EXWY: 'EXPRESSWAY', HWY: 'HIGHWAY', TPKE: 'TURNPIKE', TPK: 'TURNPIKE', RD: 'ROAD',
  LN: 'LANE', CT: 'COURT', TER: 'TERRACE', TERR: 'TERRACE', SQ: 'SQUARE', CIR: 'CIRCLE',
  HTS: 'HEIGHTS', MT: 'MOUNT', FT: 'FORT', JR: 'JUNIOR', BRG: 'BRIDGE', PLZ: 'PLAZA',
  CRES: 'CRESCENT', STS: 'STREETS', WY: 'WAY', CONC: 'CONCOURSE',
  TUNL: 'TUNNEL', TNNL: 'TUNNEL', ALY: 'ALLEY', DRV: 'DRIVE', GDNS: 'GARDENS', BRDG: 'BRIDGE', BDWK: 'BOARDWALK', BCH: 'BEACH',
};
const DIRECTIONS = { E: 'EAST', W: 'WEST', N: 'NORTH', S: 'SOUTH' };
const FILLER = new Set(['OF', 'THE']);
const ORD = /^(\d+)(ST|ND|RD|TH)$/;

export function clave(text) {
  const s = text.normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\([^)]*\)/g, ' ').toUpperCase().replace(/['’]/g, '');
  const words = s.replace(/[^A-Z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  const last = words.length - 1;
  const out = [];
  words.forEach((w0, i) => {
    let w = w0;
    const m = ORD.exec(w);
    if (m) w = m[1];
    else if (w in ORDINAL_WORDS) w = ORDINAL_WORDS[w];
    else if (w === 'ST') w = i === last && i > 0 ? 'STREET' : 'SAINT';
    else if (w === 'DR') w = i === 0 && last > 0 ? 'DOCTOR' : 'DRIVE';
    else if (w in DIRECTIONS && ((i === 0 && last > 0) || (i === last && i >= 2))) w = DIRECTIONS[w];
    else w = ABBREV[w] ?? w;
    if (!FILLER.has(w)) out.push(w);
  });
  return out.join(' ');
}
