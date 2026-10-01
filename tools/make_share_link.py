#!/usr/bin/env python3
"""
Build the #cfg share link (+ QR) for the crew. Run on YOUR computer; the key never goes to the repo.

  python tools/make_share_link.py                       # prompts for everything (key is hidden)
  python tools/make_share_link.py --app https://USER.github.io/vin-tracker/ --url https://script.google.com/macros/s/.../exec
  (key: prompted, or env VT_API_KEY)
  --csv URL   optional read-only fallback list: the published ...pub?output=csv link (or env VT_CSV_URL)

Writes share-qr.png in the current folder (git-ignored) if the `qrcode` package is installed:
  python3 -m venv .venv && .venv/bin/pip install qrcode pillow && .venv/bin/python tools/make_share_link.py
Treat the link and QR like a password: anyone who has it can read and write statuses.
"""
import argparse, base64, getpass, json, os, sys

def build(app, url, key, csv=''):
    d = {'u': url, 'k': key}
    if csv:
        d['c'] = csv
    cfg = json.dumps(d, separators=(',', ':')).encode()
    b64 = base64.urlsafe_b64encode(cfg).decode().rstrip('=')
    return app.split('#')[0].rstrip('/') + '/#cfg=' + b64

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--app', help='URL where the web app is hosted')
    ap.add_argument('--url', help='Apps Script web app URL (ends with /exec)')
    ap.add_argument('--csv', help='Published-sheet CSV URL (pub?output=csv): read-only fallback list')
    ap.add_argument('--out', default='share-qr.png')
    a = ap.parse_args()
    app = a.app or input('App URL (e.g. https://shoutinggoat0.github.io/vin-tracker/): ').strip()
    url = a.url or input('Apps Script web app URL (…/exec): ').strip()
    csv = a.csv if a.csv is not None else os.environ.get('VT_CSV_URL', '')
    key = os.environ.get('VT_API_KEY') or getpass.getpass('API key (hidden): ').strip()
    if not app.startswith('https://') or not url.startswith('https://') or not key:
        sys.exit('App URL and Apps Script URL must start with https:// and the key must not be empty.')
    if csv and not csv.startswith('https://'):
        sys.exit('CSV URL must start with https://')
    link = build(app, url, key, csv)
    print('\nShare link:\n' + link + '\n')
    try:
        import qrcode
        img = qrcode.make(link, error_correction=qrcode.constants.ERROR_CORRECT_M, box_size=8, border=3)
        img.save(a.out)
        print('QR saved to ' + os.path.abspath(a.out))
    except ImportError:
        print('(install `qrcode` + `pillow` in a venv to also get a QR image)')

if __name__ == '__main__':
    main()
