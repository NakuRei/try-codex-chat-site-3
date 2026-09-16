"""Browser smoke tests. Production has no Python/Playwright dependency.

Run: python -m pip install playwright; python -m playwright install chromium
     python tests/smoke.py
Optional: CHROMIUM_PATH=/usr/bin/chromium

The harness inlines the three local source files into an about:blank page.
Storage round-trips use a controlled in-memory adapter because that page has
no origin. Denied storage is tested separately with the native browser API.
Actual HTTP hosting and OS audio output are outside this suite's scope.
"""
from pathlib import Path
import json
import os
import tempfile
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
HTML = (ROOT / 'index.html').read_text(encoding='utf-8')
HTML = HTML.replace('<link rel="stylesheet" href="./styles.css">', '<style>' + (ROOT / 'styles.css').read_text(encoding='utf-8') + '</style>')
HTML = HTML.replace('<script src="./app.js" defer></script>', '')
HTML = HTML.replace('<link rel="icon" href="./favicon.svg" type="image/svg+xml">', '')
HTML = HTML.replace('</body>', '<script>' + (ROOT / 'app.js').read_text(encoding='utf-8') + '</script></body>')
KEY = 'yohaku.settings.v1'
ERRORS = []
PASSED = []


def check(label, condition):
    assert condition, label
    PASSED.append(label)
    print('PASS', label)


def load(browser, width=1440, motion='no-preference', storage=None, touch=False, no_audio=False):
    context = browser.new_context(viewport={'width': width, 'height': 1000}, reduced_motion=motion, has_touch=touch, is_mobile=touch, accept_downloads=True)
    page = context.new_page()
    page.on('pageerror', lambda error: ERRORS.append(str(error)))
    if storage is not None:
        page.evaluate('''(initial) => {
            const data = new Map(Object.entries(initial));
            Object.defineProperty(window, 'localStorage', {configurable: true, value: {
                getItem: key => data.get(key) ?? null,
                setItem: (key, value) => data.set(key, String(value)),
                removeItem: key => data.delete(key), clear: () => data.clear()
            }});
        }''', storage)
    if no_audio:
        page.evaluate('window.AudioContext = undefined; window.webkitAudioContext = undefined;')
    page.set_content(HTML, wait_until='load')
    return context, page


def pixels(page):
    return page.locator('#artboard').evaluate("el => el.toDataURL('image/png')")


def set_range(page, name, value):
    page.locator('#' + name).evaluate('(el, value) => {el.value = value; el.dispatchEvent(new Event("input", {bubbles: true}));}', str(value))


with sync_playwright() as p:
    launch = {'headless': True, 'args': ['--no-sandbox']}
    if os.environ.get('CHROMIUM_PATH'):
        launch['executable_path'] = os.environ['CHROMIUM_PATH']
    browser = p.chromium.launch(**launch)
    context, page = load(browser, storage={})
    check('Japanese page title', page.title() == 'YOHAKU — 余白の実験室')
    check('Sound defaults to OFF', page.locator('#sound-button').get_attribute('aria-pressed') == 'false')
    check('One selected experiment', page.locator('[data-mode][aria-pressed=true]').count() == 1)
    page.locator('#pause-button').click()
    frozen = pixels(page)
    page.wait_for_timeout(200)
    check('Pause actually freezes canvas', pixels(page) == frozen)
    mode_images = set()
    for mode in ['flow', 'ripple', 'orbit']:
        page.locator(f'[data-mode={mode}]').click()
        check(f'{mode} mode selects correctly', page.locator(f'[data-mode={mode}]').get_attribute('aria-pressed') == 'true')
        mode_images.add(pixels(page))
    check('Three distinct rendered artworks', len(mode_images) == 3)
    for name, value, text in [('energy', 87, '87%'), ('density', 49, '49'), ('speed', 120, '1.20×')]:
        set_range(page, name, value)
        check(name + ' slider updates value', page.locator('#' + name + '-value').inner_text() == text)
    page.locator('[data-palette="1"]').click()
    check('Palette selection', page.locator('#palette-name').inner_text() == '日暮れ')
    stored = page.evaluate('(key) => localStorage.getItem(key)', KEY)
    saved = json.loads(stored)
    check('Settings write through storage adapter', saved['energy'] == 87 and saved['mode'] == 'orbit' and saved['palette'] == 1)
    with page.expect_download(timeout=5000) as info:
        page.locator('#save-button').click()
    download = info.value
    with tempfile.TemporaryDirectory() as folder:
        path = Path(folder) / 'art.png'
        download.save_as(path)
        data = path.read_bytes()
        check('Real PNG download', data[:8] == b'\x89PNG\r\n\x1a\n' and len(data) > 10000)
    check('Download includes mode and seed', download.suggested_filename == 'yohaku-orbit-018624.png')
    page.locator('#sound-button').click()
    check('Web Audio enables after explicit action', page.locator('#sound-button').get_attribute('aria-pressed') == 'true')
    check('Volume control appears', page.locator('#volume-control').is_visible())
    set_range(page, 'volume', 10)
    check('Volume can be changed', page.locator('#volume-value').inner_text() == '10%')
    page.locator('#artboard').click(position={'x': 150, 'y': 150})
    page.locator('#sound-button').click()
    check('Sound disables', page.locator('#sound-button').get_attribute('aria-pressed') == 'false')
    page.locator('#artboard').focus()
    page.keyboard.press('2')
    check('Keyboard mode shortcut', page.locator('[data-mode=ripple]').get_attribute('aria-pressed') == 'true')
    before = pixels(page)
    page.keyboard.press('ArrowRight')
    page.keyboard.press('Enter')
    check('Keyboard canvas interaction', pixels(page) != before)
    page.locator('#energy').focus()
    page.keyboard.press('ArrowRight')
    check('Range retains native keyboard behavior', page.locator('#energy-value').inner_text() == '88%')
    page.locator('#pause-button').click()
    before = pixels(page)
    page.wait_for_timeout(200)
    check('Animation resumes', pixels(page) != before)
    page.locator('#random-button').click()
    check('Random configuration in bounds', 10 <= int(page.locator('#energy').input_value()) <= 100)
    page.locator('#reset-button').click()
    check('Reset restores original seed and mode', page.locator('#seed-label').inner_text() == 'SEED 018624' and page.locator('[data-mode=flow]').get_attribute('aria-pressed') == 'true')
    page.locator('.shortcuts summary').click()
    check('Keyboard help opens', page.locator('.shortcut-content').is_visible())
    context.close()

    context, page = load(browser, storage={KEY: stored})
    check('Stored settings are read and restored', page.locator('#energy').input_value() == '87' and page.locator('[data-mode=orbit]').get_attribute('aria-pressed') == 'true')
    check('Restoring settings never enables sound', page.locator('#sound-button').get_attribute('aria-pressed') == 'false')
    context.close()
    context, page = load(browser, storage={KEY: '{broken-json'})
    check('Corrupt storage falls back safely', page.locator('#energy').input_value() == '55')
    context.close()
    context, page = load(browser, storage={KEY: json.dumps({'mode':'__proto__', 'energy':999, 'density':-9, 'speed':'x', 'palette':99})})
    check('Stored values are validated and clamped', page.locator('#energy').input_value() == '100' and page.locator('#density').input_value() == '12' and page.locator('[data-mode=flow]').get_attribute('aria-pressed') == 'true')
    context.close()
    context, page = load(browser, motion='reduce')
    check('Reduced motion starts paused', page.locator('#pause-button').get_attribute('aria-pressed') == 'true')
    before = pixels(page)
    page.wait_for_timeout(150)
    check('Reduced motion has no initial animation', pixels(page) == before)
    page.locator('#random-button').click()
    check('Denied localStorage does not stop interaction', '偶然' in page.locator('#toast').inner_text())
    check('Unavailable storage is disclosed', '利用できません' in page.locator('.local-note').inner_text())
    context.close()
    context, page = load(browser, no_audio=True)
    page.locator('#sound-button').click()
    check('Unsupported audio degrades gracefully', '対応していません' in page.locator('#toast').inner_text() and page.locator('#sound-button').get_attribute('aria-pressed') == 'false')
    context.close()

    for width in [320, 390, 600, 768, 1024, 1440]:
        context, page = load(browser, width=width, motion='reduce', touch=width < 600)
        check(f'No horizontal overflow at {width}px', page.evaluate('document.documentElement.scrollWidth <= innerWidth'))
        if width == 390:
            page.locator('[data-mode=ripple]').tap()
            before = pixels(page)
            page.locator('#artboard').tap(position={'x': 160, 'y': 170})
            check('Touch interaction produces a ripple', pixels(page) != before)
        context.close()
    browser.close()
    check('No JavaScript runtime errors', not ERRORS)
print(f'\n{len(PASSED)} checks passed. No JavaScript runtime errors.')
