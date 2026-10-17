"""Publish Update: puts your latest Hotel of the Dead on the website so every player gets it.

What it does, in order:
  1. stamps a new version number into the game and copies it to docs/play/ (the browser version)
  2. writes docs/version.json (version, date, the notes from changelog.txt)
  3. tells your desktop app where updates live, so it can update itself
  4. commits and pushes to GitHub: GitHub Pages rebuilds the site, Render restarts the online hub

Run it with "Publish Update.bat" in the game folder.  Add --zip to also build the desktop zip for GitHub Releases.
"""
import datetime, hashlib, json, os, re, shutil, subprocess, sys, zipfile

HERE = os.path.dirname(os.path.abspath(__file__))           # ...\Hotel of the Dead\online
GAME = os.path.dirname(HERE)                                  # ...\Hotel of the Dead
CFG = os.path.join(HERE, 'config.json')
APP = os.path.join(os.environ.get('LOCALAPPDATA', ''), 'Programs', 'Hotel of the Dead')


def ask(q, default=''):
    a = input(f'{q}{" [" + default + "]" if default else ""}: ').strip()
    return a or default


def git(*args, check=True):
    print('  > git', ' '.join(args))
    return subprocess.run(['git', *args], cwd=HERE, check=check)


def main():
    cfg = {}
    if os.path.exists(CFG):
        cfg = json.load(open(CFG, encoding='utf-8'))
    if not cfg.get('user'):
        print('First time setup. You need a free GitHub account and an empty public repository (see ONLINE-SETUP.txt).')
        cfg['user'] = ask('Your GitHub username')
        cfg['repo'] = ask('Repository name', 'hotel-of-the-dead')
    if 'hub' not in cfg or '--ask-hub' in sys.argv:
        cfg['hub'] = ask('Online hub address from Render (e.g. https://hotd-hub.onrender.com), or press Enter to skip for now', '')
    if '--hub' in sys.argv:
        cfg['hub'] = sys.argv[sys.argv.index('--hub') + 1]
    cfg['site'] = f"https://{cfg['user'].lower()}.github.io/{cfg['repo']}"
    json.dump(cfg, open(CFG, 'w', encoding='utf-8'), indent=2)

    version = datetime.datetime.now().strftime('%Y.%m.%d.%H%M')
    print(f'\nPublishing version {version}')

    # 1) the browser version
    play = os.path.join(HERE, 'docs', 'play')
    os.makedirs(play, exist_ok=True)
    html = open(os.path.join(GAME, 'index.html'), encoding='utf-8').read()
    html = re.sub(r"const CLOUD_HUB=/\*HUB\*/'[^']*';", "const CLOUD_HUB=/*HUB*/'%s';" % cfg.get('hub', '').rstrip('/'), html)
    html = re.sub(r"const GAME_VERSION=/\*VER\*/'[^']*';", "const GAME_VERSION=/*VER*/'%s';" % version, html)
    open(os.path.join(play, 'index.html'), 'w', encoding='utf-8').write(html)
    # copy over the top (OneDrive can hold folders open, so never delete them first)
    shutil.copytree(os.path.join(GAME, 'lib'), os.path.join(play, 'lib'), dirs_exist_ok=True)
    files = ['index.html']
    for root, _, names in os.walk(os.path.join(play, 'lib')):
        for n in names:
            files.append(os.path.relpath(os.path.join(root, n), play).replace('\\', '/'))

    # 2) version.json with the newest section of changelog.txt
    notes = ''
    cl = os.path.join(GAME, 'changelog.txt')
    if os.path.exists(cl):
        notes = open(cl, encoding='utf-8').read().strip().split('\n\n')[0]
    json.dump({'version': version, 'date': datetime.datetime.now().isoformat(timespec='seconds'), 'notes': notes, 'files': files, 'desktop': cfg.get('desktop', '')},
              open(os.path.join(HERE, 'docs', 'version.json'), 'w', encoding='utf-8'), indent=1)
    open(os.path.join(HERE, 'docs', '.nojekyll'), 'w').close()

    # 3) the desktop app on this PC learns where updates come from
    upd = {'site': cfg['site']}
    if os.path.isdir(os.path.join(APP, 'resources', 'app')) and '--nopush' not in sys.argv:
        json.dump(upd, open(os.path.join(APP, 'resources', 'app', 'update.json'), 'w'), indent=1)
        print('  desktop app on this PC will update from', cfg['site'])

    # optional: the desktop zip for GitHub Releases (only needed the first time, or when the app itself changes)
    if '--zip' in sys.argv and os.path.isdir(APP):
        out = os.path.join(HERE, 'release', 'HotelOfTheDead-Desktop.zip')
        os.makedirs(os.path.dirname(out), exist_ok=True)
        with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
            for name in ('Install.bat', 'README-desktop.txt'):
                src = os.path.join(GAME, 'desktop-app-source', name)
                if os.path.exists(src):
                    z.write(src, 'Hotel of the Dead Desktop/' + ('README.txt' if name.startswith('README') else name))
            for root, _, names in os.walk(APP):
                for n in names:
                    p = os.path.join(root, n)
                    rel = os.path.relpath(p, APP).replace('\\', '/')
                    if rel == 'resources/app/update.json':
                        continue
                    z.write(p, 'Hotel of the Dead Desktop/Hotel of the Dead/' + rel)
            z.writestr('Hotel of the Dead Desktop/Hotel of the Dead/resources/app/update.json', json.dumps(upd))
        # the OneDrive copy is what the website's Download button points at: overwrite it in place (keeps the share link)
        od = os.path.join(GAME, 'HotelOfTheDead-Desktop.zip')
        if os.path.exists(od):
            data = open(out, 'rb').read()
            with open(od, 'r+b') as f:
                f.seek(0); f.write(data); f.truncate()
            print('  Updated the OneDrive download too (same link).')
        print('\n  Desktop zip ready:', out)
        print(f"  Upload it at https://github.com/{cfg['user']}/{cfg['repo']}/releases/new (tag: v{version})")

    # 4) push
    if '--nopush' in sys.argv:
        print('(test run: not pushing)')
        return 0
    if not os.path.isdir(os.path.join(HERE, '.git')):
        git('init', '-b', 'main')
        git('remote', 'add', 'origin', f"https://github.com/{cfg['user']}/{cfg['repo']}.git")
    with open(os.path.join(HERE, '.gitignore'), 'w') as f:
        f.write('release/\nconfig.json\n__pycache__/\n')
    git('add', '-A')
    git('commit', '-m', f'Update {version}', check=False)
    r = git('push', '-u', 'origin', 'main', check=False)
    if r.returncode != 0:
        print('\nThe push did not go through. Check your internet, then run Publish Update again.')
        print('(The first time, Windows asks you to sign in to GitHub in your browser.)')
        return 1
    print(f"\nDone! In a minute or two the new version is live at {cfg['site']}/")
    print('Desktop players get it the next time they open the game; browser players on their next visit.')
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    finally:
        if os.name == 'nt' and sys.stdin and sys.stdin.isatty():
            try:
                input('\nPress Enter to close.')
            except EOFError:
                pass
