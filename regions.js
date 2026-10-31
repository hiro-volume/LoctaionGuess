// マップ選択画面のカテゴリ（"all" と "custom" は特別扱い）
window.LG_CATEGORIES = [
  { id: "all", name: "すべて" },
  { id: "asia", name: "アジア" },
  { id: "europe", name: "ヨーロッパ" },
  { id: "namerica", name: "北アメリカ" },
  { id: "samerica", name: "南アメリカ" },
  { id: "africa", name: "アフリカ" },
  { id: "oceania", name: "オセアニア" },
  { id: "custom", name: "自作" },
];

// 国の範囲は、世界の国境データ（world-boundary.js、[経度, 緯度]）から作る。
// keep（[南, 西, 北, 東]）があれば、その枠にかかる島だけを使う（海外領土を除いて本土だけにする等）
function countryRings(iso, keep) {
  const c = (window.LG_WORLD || []).find((x) => x.id === iso);
  if (!c) return [];
  return c.rings
    .filter((r) => !keep || r.some(([lng, lat]) => lat >= keep[0] && lat <= keep[2] && lng >= keep[1] && lng <= keep[3]))
    .map((r) => r.map(([lng, lat]) => [lat, lng]));
}

// 「全世界」で出題に使う、Google のストリートビューが広く撮影されている国
window.LG_WORLD_COVERAGE = [
  "JPN", "KOR", "TWN", "THA", "MYS", "IDN", "PHL", "KHM", "LAO", "LKA", "BGD", "IND", "MNG", "BTN", "KGZ", "ISR", "JOR", "TUR", "ARE", "RUS",
  "FRA", "ITA", "ESP", "PRT", "GBR", "IRL", "NLD", "BEL", "LUX", "CHE", "AUT", "DEU", "POL", "CZE", "SVK", "HUN", "ROU", "BGR", "GRC",
  "HRV", "SVN", "SRB", "MNE", "MKD", "ALB", "DNK", "NOR", "SWE", "FIN", "EST", "LVA", "LTU", "ISL", "UKR",
  "USA", "CAN", "MEX", "GTM", "CRI", "PAN", "DOM", "COL", "ECU", "PER", "BOL", "CHL", "ARG", "URY", "BRA",
  "ZAF", "BWA", "LSO", "SWZ", "KEN", "UGA", "RWA", "NGA", "GHA", "SEN", "TUN",
  "AUS", "NZL",
];

// 出題範囲のプリセット
// type "polygons": rings は [[緯度, 経度], ...] の配列（島ごと）
// type "circle": center と radius（メートル）
// difficulty: カードに出す難易度の目安（easy / normal / hard）
// image: カードに出す写真（Wikimedia Commons。クレジット表記が必要なライセンス）
window.LG_PRESETS = [
  {
    id: "world",
    name: "全世界",
    category: "world",
    difficulty: "hard",
    description: "世界中のどこかへ。国当てから始めよう",
    image: {
      src: "https://upload.wikimedia.org/wikipedia/commons/thumb/9/97/The_Earth_seen_from_Apollo_17.jpg/960px-The_Earth_seen_from_Apollo_17.jpg",
      credit: "NASA / Public domain",
      link: "https://commons.wikimedia.org/wiki/File:The_Earth_seen_from_Apollo_17.jpg",
    },
    type: "world",
  },
  {
    id: "singapore",
    name: "シンガポール",
    category: "asia",
    difficulty: "normal",
    description: "高層ビル街と緑の多い住宅地",
    image: {
      src: "https://upload.wikimedia.org/wikipedia/commons/thumb/f/f9/Marina_Bay_Sands_in_the_evening_-_20101120.jpg/960px-Marina_Bay_Sands_in_the_evening_-_20101120.jpg",
      credit: "Someformofhuman / CC BY-SA 3.0",
      link: "https://commons.wikimedia.org/wiki/File:Marina_Bay_Sands_in_the_evening_-_20101120.jpg",
    },
    type: "polygons",
    rings: [[
      [1.4480, 103.7700], [1.4500, 103.8000], [1.4560, 103.8300], [1.4450, 103.8700],
      [1.4250, 103.9100], [1.4100, 103.9500], [1.3980, 103.9850], [1.3900, 104.0300],
      [1.3500, 104.0450], [1.3150, 103.9900], [1.2950, 103.9000], [1.2700, 103.8600],
      [1.2400, 103.8300], [1.2500, 103.8000], [1.2650, 103.7700], [1.2900, 103.7300],
      [1.3000, 103.6500], [1.3300, 103.6300], [1.3700, 103.6650], [1.4100, 103.6950],
      [1.4400, 103.7300],
    ]],
  },
  {
    id: "hiroshima",
    name: "広島県",
    category: "asia",
    difficulty: "hard",
    description: "瀬戸内の島々から中国山地まで",
    image: {
      src: "https://upload.wikimedia.org/wikipedia/commons/thumb/e/ef/Itsukushima_Shrine_Torii_Gate_%2813890465459%29.jpg/960px-Itsukushima_Shrine_Torii_Gate_%2813890465459%29.jpg",
      credit: "redlegsfan21 / CC BY-SA 2.0",
      link: "https://commons.wikimedia.org/wiki/File:Itsukushima_Shrine_Torii_Gate_(13890465459).jpg",
    },
    type: "polygons",
    rings: window.HIROSHIMA_RINGS,
  },
  {
    id: "hiroshima-city",
    name: "広島市中心部",
    category: "asia",
    difficulty: "easy",
    description: "路面電車が走るデルタの街",
    image: {
      src: "https://upload.wikimedia.org/wikipedia/commons/thumb/7/77/Genbaku_Dome04-r.JPG/960px-Genbaku_Dome04-r.JPG",
      credit: "Oilstreet / CC BY 2.5",
      link: "https://commons.wikimedia.org/wiki/File:Genbaku_Dome04-r.JPG",
    },
    type: "circle",
    center: { lat: 34.3963, lng: 132.4596 },
    radius: 5000,
  },
  {
    id: "japan",
    name: "日本",
    category: "asia",
    difficulty: "normal",
    description: "北海道から沖縄まで、日本全国",
    image: {
      src: "https://upload.wikimedia.org/wikipedia/commons/thumb/6/67/Streets_of_Gion%2C_Kyoto_-_Gion7709.jpg/960px-Streets_of_Gion%2C_Kyoto_-_Gion7709.jpg",
      credit: "lumoplank / CC0",
      link: "https://commons.wikimedia.org/wiki/File:Streets_of_Gion,_Kyoto_-_Gion7709.jpg",
    },
    type: "polygons",
    iso: "JPN",
    rings: countryRings("JPN"),
  },
  {
    id: "thailand",
    name: "タイ",
    category: "asia",
    difficulty: "normal",
    description: "寺院と屋台、南国の道",
    image: {
      src: "https://upload.wikimedia.org/wikipedia/commons/thumb/b/b5/Temple_of_the_Emerald_Buddha.jpg/960px-Temple_of_the_Emerald_Buddha.jpg",
      credit: "Nawit science / CC BY-SA 4.0",
      link: "https://commons.wikimedia.org/wiki/File:Temple_of_the_Emerald_Buddha.jpg",
    },
    type: "polygons",
    iso: "THA",
    rings: countryRings("THA"),
  },
  {
    id: "france",
    name: "フランス",
    category: "europe",
    difficulty: "normal",
    description: "石畳の街とぶどう畑（本土とコルシカ島）",
    image: {
      src: "https://upload.wikimedia.org/wikipedia/commons/thumb/c/c4/Arc_Triomphe.jpg/960px-Arc_Triomphe.jpg",
      credit: "Benh LIEU SONG / CC BY-SA 3.0",
      link: "https://commons.wikimedia.org/wiki/File:Arc_Triomphe.jpg",
    },
    type: "polygons",
    iso: "FRA",
    rings: countryRings("FRA", [41, -5.5, 51.5, 10]),
  },
  {
    id: "italy",
    name: "イタリア",
    category: "europe",
    difficulty: "normal",
    description: "古い街並みと地中海の景色",
    image: {
      src: "https://upload.wikimedia.org/wikipedia/commons/thumb/5/53/Colosseum_in_Rome%2C_Italy_-_April_2007.jpg/960px-Colosseum_in_Rome%2C_Italy_-_April_2007.jpg",
      credit: "Diliff / CC BY-SA 2.5",
      link: "https://commons.wikimedia.org/wiki/File:Colosseum_in_Rome,_Italy_-_April_2007.jpg",
    },
    type: "polygons",
    iso: "ITA",
    rings: countryRings("ITA"),
  },
  {
    id: "uk",
    name: "イギリス",
    category: "europe",
    difficulty: "normal",
    description: "レンガの家と緑の丘、左側通行",
    image: {
      src: "https://upload.wikimedia.org/wikipedia/commons/thumb/9/97/Big_Ben_at_sunset_-_2014-10-27_17-30.jpg/960px-Big_Ben_at_sunset_-_2014-10-27_17-30.jpg",
      credit: "Colin / CC BY-SA 4.0",
      link: "https://commons.wikimedia.org/wiki/File:Big_Ben_at_sunset_-_2014-10-27_17-30.jpg",
    },
    type: "polygons",
    iso: "GBR",
    rings: countryRings("GBR"),
  },
  {
    id: "usa",
    name: "アメリカ",
    category: "namerica",
    difficulty: "hard",
    description: "大都市から砂漠の一本道まで（本土48州）",
    image: {
      src: "https://upload.wikimedia.org/wikipedia/commons/thumb/6/69/New_York_City_%28New_York%2C_USA%29%2C_Times_Square-Duffy_Square_--_2012_--_6380.jpg/960px-New_York_City_%28New_York%2C_USA%29%2C_Times_Square-Duffy_Square_--_2012_--_6380.jpg",
      credit: "Dietmar Rabich / CC BY-SA 4.0",
      link: "https://commons.wikimedia.org/wiki/File:New_York_City_(New_York,_USA),_Times_Square-Duffy_Square_--_2012_--_6380.jpg",
    },
    type: "polygons",
    iso: "USA",
    rings: countryRings("USA", [24, -125, 50, -66]),
  },
  {
    id: "mexico",
    name: "メキシコ",
    category: "namerica",
    difficulty: "hard",
    description: "カラフルな街並みと乾いた大地",
    image: {
      src: "https://upload.wikimedia.org/wikipedia/commons/thumb/c/c3/Plaza_de_la_Constituci%C3%B3n_-_Z%C3%B3calo_de_la_Ciudad_de_M%C3%A9xico_-_6.jpg/960px-Plaza_de_la_Constituci%C3%B3n_-_Z%C3%B3calo_de_la_Ciudad_de_M%C3%A9xico_-_6.jpg",
      credit: "ProtoplasmaKid / CC BY-SA 4.0",
      link: "https://commons.wikimedia.org/wiki/File:Plaza_de_la_Constituci%C3%B3n_-_Z%C3%B3calo_de_la_Ciudad_de_M%C3%A9xico_-_6.jpg",
    },
    type: "polygons",
    iso: "MEX",
    rings: countryRings("MEX"),
  },
  {
    id: "brazil",
    name: "ブラジル",
    category: "samerica",
    difficulty: "hard",
    description: "赤土の道と熱帯の街",
    image: {
      src: "https://upload.wikimedia.org/wikipedia/commons/thumb/0/04/Rio_de_Janeiro_skyline_and_Sugarloaf_Mountain_at_sunset%2C_Brazil_3.jpg/960px-Rio_de_Janeiro_skyline_and_Sugarloaf_Mountain_at_sunset%2C_Brazil_3.jpg",
      credit: "Wilfredor / CC0",
      link: "https://commons.wikimedia.org/wiki/File:Rio_de_Janeiro_skyline_and_Sugarloaf_Mountain_at_sunset,_Brazil_3.jpg",
    },
    type: "polygons",
    iso: "BRA",
    rings: countryRings("BRA"),
  },
  {
    id: "argentina",
    name: "アルゼンチン",
    category: "samerica",
    difficulty: "hard",
    description: "パンパの平原からパタゴニアまで",
    image: {
      src: "https://upload.wikimedia.org/wikipedia/commons/thumb/3/39/Obelisco_de_Buenos_Aires%2C_with_traffic_lights.jpg/960px-Obelisco_de_Buenos_Aires%2C_with_traffic_lights.jpg",
      credit: "Vicpics / CC BY-SA 4.0",
      link: "https://commons.wikimedia.org/wiki/File:Obelisco_de_Buenos_Aires,_with_traffic_lights.jpg",
    },
    type: "polygons",
    iso: "ARG",
    rings: countryRings("ARG"),
  },
  {
    id: "south-africa",
    name: "南アフリカ",
    category: "africa",
    difficulty: "hard",
    description: "ケープタウンとサバンナの道",
    image: {
      src: "https://upload.wikimedia.org/wikipedia/commons/thumb/4/43/Cape_Town_%28ZA%29%2C_Table_Mountain_--_2024_--_2825.jpg/960px-Cape_Town_%28ZA%29%2C_Table_Mountain_--_2024_--_2825.jpg",
      credit: "Dietmar Rabich / CC BY-SA 4.0",
      link: "https://commons.wikimedia.org/wiki/File:Cape_Town_(ZA),_Table_Mountain_--_2024_--_2825.jpg",
    },
    type: "polygons",
    iso: "ZAF",
    rings: countryRings("ZAF"),
  },
  {
    id: "kenya",
    name: "ケニア",
    category: "africa",
    difficulty: "hard",
    description: "赤道直下の高原と町",
    image: {
      src: "https://upload.wikimedia.org/wikipedia/commons/thumb/8/82/Nairobi_Skyline_Savannah_Kenya_May19_R1600687.jpg/960px-Nairobi_Skyline_Savannah_Kenya_May19_R1600687.jpg",
      credit: "Timothy A. Gonsalves / CC BY-SA 4.0",
      link: "https://commons.wikimedia.org/wiki/File:Nairobi_Skyline_Savannah_Kenya_May19_R1600687.jpg",
    },
    type: "polygons",
    iso: "KEN",
    rings: countryRings("KEN"),
  },
  {
    id: "australia",
    name: "オーストラリア",
    category: "oceania",
    difficulty: "hard",
    description: "海辺の街と果てしない内陸",
    image: {
      src: "https://upload.wikimedia.org/wikipedia/commons/thumb/7/7c/Sydney_Opera_House_-_Dec_2008.jpg/960px-Sydney_Opera_House_-_Dec_2008.jpg",
      credit: "Diliff / CC BY-SA 3.0",
      link: "https://commons.wikimedia.org/wiki/File:Sydney_Opera_House_-_Dec_2008.jpg",
    },
    type: "polygons",
    iso: "AUS",
    rings: countryRings("AUS"),
  },
  {
    id: "new-zealand",
    name: "ニュージーランド",
    category: "oceania",
    difficulty: "normal",
    description: "山と湖、羊のいる牧草地",
    image: {
      src: "https://upload.wikimedia.org/wikipedia/commons/thumb/4/44/Lake_Pukaki_20.jpg/960px-Lake_Pukaki_20.jpg",
      credit: "Krzysztof Golik / CC BY-SA 4.0",
      link: "https://commons.wikimedia.org/wiki/File:Lake_Pukaki_20.jpg",
    },
    type: "polygons",
    iso: "NZL",
    rings: countryRings("NZL"),
  },
];
