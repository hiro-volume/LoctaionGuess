"""LoctaionGuess の APIキー使用量モニター（自分の PC だけで動かす）

Google Cloud Monitoring から、Google Maps Platform の「本当の使用回数」を読み出して、
http://127.0.0.1:8765 に表示する。ゲームのブラウザごとのカウンターと違い、
友達のブラウザや別の端末で使った分も含めた、APIキー全体の回数がわかる。

使い方:
    pip install google-auth requests
    python monitor/monitor.py            # 本番（service-account.json が必要）
    python monitor/monitor.py --demo     # 認証なしで、見た目だけ確認する

認証には、読み取り専用（モニタリング閲覧者）のサービスアカウントの鍵を使う。
鍵は monitor/service-account.json に置く。このファイルは絶対に公開しないこと（.gitignore 済み）。
"""

import argparse
import datetime as dt
import json
import random
import sys
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
KEY_FILE = HERE / "service-account.json"
DASHBOARD = HERE / "dashboard.html"
HOST = "127.0.0.1"  # 自分の PC からしか開けないようにする
PORT = 8765
CACHE_SECONDS = 120  # Monitoring API を叩きすぎないよう、結果を少しの間覚えておく

METRIC_FILTER = (
    'metric.type="maps.googleapis.com/service/request_count" '
    'resource.type="maps.googleapis.com/Api"'
)


# ---------------------------------------------------------------- Google Cloud Monitoring から読む

class MonitoringClient:
    def __init__(self, key_file):
        try:
            from google.oauth2 import service_account
            from google.auth.transport.requests import AuthorizedSession
        except ImportError:
            sys.exit("google-auth が入っていません。先に `pip install google-auth requests` を実行してください。")
        if not key_file.exists():
            sys.exit(f"鍵ファイルが見つかりません: {key_file}\nREADME の「使用量モニター」の手順で用意してください。")
        info = json.loads(key_file.read_text(encoding="utf-8"))
        self.project = info["project_id"]
        creds = service_account.Credentials.from_service_account_info(
            info, scopes=["https://www.googleapis.com/auth/monitoring.read"])
        self.session = AuthorizedSession(creds)

    def daily_counts(self, start, end):
        """service・method・日ごとの成功したリクエスト数を返す"""
        url = f"https://monitoring.googleapis.com/v3/projects/{self.project}/timeSeries"
        params = {
            "filter": METRIC_FILTER,
            "interval.startTime": start.isoformat().replace("+00:00", "Z"),
            "interval.endTime": end.isoformat().replace("+00:00", "Z"),
            "aggregation.alignmentPeriod": "86400s",
            "aggregation.perSeriesAligner": "ALIGN_SUM",
            "aggregation.crossSeriesReducer": "REDUCE_SUM",
            "aggregation.groupByFields": [
                "resource.labels.service", "resource.labels.method", "metric.labels.response_code_class"],
            "pageSize": 1000,
        }
        rows = []
        while True:
            res = self.session.get(url, params=params, timeout=30)
            if res.status_code != 200:
                raise RuntimeError(f"Monitoring API エラー {res.status_code}: {res.text[:300]}")
            data = res.json()
            for ts in data.get("timeSeries", []):
                labels = {**ts.get("resource", {}).get("labels", {}), **ts.get("metric", {}).get("labels", {})}
                for p in ts.get("points", []):
                    v = p["value"]
                    rows.append({
                        "service": labels.get("service", ""),
                        "method": labels.get("method", ""),
                        "codeClass": labels.get("response_code_class", ""),
                        "day": p["interval"]["endTime"][:10],
                        "count": int(v.get("int64Value", v.get("doubleValue", 0))),
                    })
            token = data.get("nextPageToken")
            if not token:
                return rows
            params["pageToken"] = token


class DemoClient:
    """認証なしで画面を確かめるための、作りものの数字"""
    project = "demo-project"

    def daily_counts(self, start, end):
        rnd = random.Random(42)
        rows = []
        day = start
        series = [
            ("maps-backend.googleapis.com", "google.maps.StreetViewPanoramaLoad", 40),
            ("maps-backend.googleapis.com", "google.maps.MapLoad", 12),
            ("street-view-image-backend.googleapis.com", "google.streetview.Metadata", 260),
            ("static-maps-backend.googleapis.com", "google.maps.StaticMap", 6),
        ]
        while day < end:
            for service, method, base in series:
                rows.append({"service": service, "method": method, "codeClass": "2xx",
                             "day": day.date().isoformat(), "count": max(0, int(base * rnd.uniform(0.2, 1.6)))})
            rows.append({"service": "maps-backend.googleapis.com", "method": "google.maps.MapLoad",
                         "codeClass": "4xx", "day": day.date().isoformat(), "count": rnd.randint(0, 3)})
            day += dt.timedelta(days=1)
        return rows


# ---------------------------------------------------------------- 集計して画面に渡す

# Google の請求は太平洋時間の月ごと。夏時間までは扱わず UTC-8 で数える（ずれても1時間）
PACIFIC = dt.timezone(dt.timedelta(hours=-8))


def month_range():
    now = dt.datetime.now(dt.timezone.utc)
    start_pt = now.astimezone(PACIFIC).replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    return start_pt.astimezone(dt.timezone.utc), now


class UsageCache:
    def __init__(self, client):
        self.client = client
        self.lock = threading.Lock()
        self.data = None
        self.at = 0

    def get(self, force=False):
        with self.lock:
            if force or not self.data or time.time() - self.at > CACHE_SECONDS:
                start, end = month_range()
                try:
                    rows = self.client.daily_counts(start, end)
                    month = start.astimezone(PACIFIC)
                    self.data = {"ok": True, "project": self.client.project, "rows": rows,
                                 "from": start.isoformat(), "to": end.isoformat(),
                                 "month": f"{month.year}年{month.month}月",
                                 "fetchedAt": dt.datetime.now(dt.timezone.utc).isoformat()}
                except Exception as e:  # 画面にエラーを出せるよう、例外は文字にして返す
                    self.data = {"ok": False, "error": str(e)}
                self.at = time.time()
            return self.data


def make_handler(cache):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path.startswith("/api/usage"):
                body = json.dumps(cache.get(force="refresh=1" in self.path), ensure_ascii=False).encode("utf-8")
                self._send(200, "application/json; charset=utf-8", body)
            elif self.path in ("/", "/index.html"):
                self._send(200, "text/html; charset=utf-8", DASHBOARD.read_bytes())
            else:
                self._send(404, "text/plain; charset=utf-8", b"not found")

        def _send(self, code, ctype, body):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass  # アクセスごとのログは出さない

    return Handler


def main():
    parser = argparse.ArgumentParser(description="LoctaionGuess の APIキー使用量モニター")
    parser.add_argument("--demo", action="store_true", help="認証なしで、作りものの数字を表示する")
    parser.add_argument("--port", type=int, default=PORT)
    parser.add_argument("--no-open", action="store_true", help="ブラウザを自動で開かない")
    args = parser.parse_args()

    client = DemoClient() if args.demo else MonitoringClient(KEY_FILE)
    server = ThreadingHTTPServer((HOST, args.port), make_handler(UsageCache(client)))
    url = f"http://{HOST}:{args.port}/"
    print(f"使用量モニター: {url}（プロジェクト: {client.project}{'、デモ' if args.demo else ''}）")
    print("止めるには Ctrl+C")
    if not args.no_open:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
