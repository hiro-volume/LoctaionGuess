// LoctaionGuess の設定ファイル
window.LG_CONFIG = {
  // Google Cloud で発行した APIキーをここに貼る（README.md の手順を参照）
  apiKey: "AIzaSyDbjUPdiZV47SOmo0SQeaArdr6u7vkf0Ng",

  // 無料枠を超えないためのアプリ側の上限（月ごと、このブラウザでの回数）
  // Google の無料枠: Dynamic Street View 5,000回/月、Dynamic Maps 10,000回/月、Static Maps 10,000回/月
  // 余裕を持たせて少なめにしてある。Cloud Console のクォータ設定と必ず併用すること。
  limits: {
    streetViewPerMonth: 4000,
    mapLoadsPerMonth: 8000,
    // 自作の範囲のサムネイル（Maps Static API）
    staticMapsPerMonth: 8000,
  },
};
