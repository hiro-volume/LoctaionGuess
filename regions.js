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

// 出題範囲のプリセット
// type "polygons": rings は [[緯度, 経度], ...] の配列（島ごと）
// type "circle": center と radius（メートル）
// difficulty: カードに出す難易度の目安（easy / normal / hard）
// image: カードに出す写真（Wikimedia Commons。クレジット表記が必要なライセンス）
window.LG_PRESETS = [
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
];
