#!/usr/bin/env python3
"""开发用静态服务器：等价 python -m http.server，但强制 Cache-Control: no-store。

背景：Chrome 对无缓存头的 ES module 走启发式缓存，改了 mvp/src/*.js 后页面
仍跑旧模块（2026-07-19 调试 LLM 链路时被坑一小时）。开发一律用本脚本。
用法：python3 mvp/tools/serve-nocache.py [port]（默认 4193，服务仓库根目录）
"""
import http.server
import os
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 4193
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        self.send_header('Expires', '0')
        super().end_headers()


if __name__ == '__main__':
    with http.server.ThreadingHTTPServer(('', PORT), NoCacheHandler) as httpd:
        print(f'serving {ROOT} on http://localhost:{PORT} (no-store)')
        httpd.serve_forever()
