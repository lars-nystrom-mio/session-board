"""Browser tests for dashboard/index.html, driven by Playwright.

The page is served from a temporary board folder holding made-up status files,
the way `python -m http.server` serves the real one. Playwright drives the Edge
or Chrome already installed (no browser download); without Playwright or a
browser the tests are skipped.

    pip install playwright
    cd dashboard && python -m unittest
"""

import functools
import json
import shutil
import tempfile
import threading
import time
import unittest
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

try:
    from playwright.sync_api import Error as PlaywrightError
    from playwright.sync_api import sync_playwright
except ImportError:  # the tests skip themselves
    sync_playwright = None

PAGE = Path(__file__).with_name('index.html')
MIN = 60_000

A = '11111111-0000-4000-8000-000000000001'  # session-board, new hooks: sent the probe
B = '22222222-0000-4000-8000-000000000002'  # session-board, new hooks: replied
C = '33333333-0000-4000-8000-000000000003'  # resurslogs, old hooks: no record of sending
D = '44444444-0000-4000-8000-000000000004'  # got the resurslogs messages, old hooks
F = '66666666-0000-4000-8000-000000000006'  # got a message from a session never on the board
X = '77777777-0000-4000-8000-000000000007'  # in a sandbox, claims a message
G = '88888888-0000-4000-8000-000000000008'  # everything on the footer at once


O = '99999999-0000-4000-8000-000000000009'  # an orchestrator whose plan waits for the go
P = 'aaaaaaaa-0000-4000-8000-00000000000a'  # delivering an item of O's plan
Q = 'bbbbbbbb-0000-4000-8000-00000000000b'  # delivered an item of O's plan
Y = 'cccccccc-0000-4000-8000-00000000000c'  # in a sandbox, with a hostile plan


def plans(now):
    """An orchestrator with a plan, two sessions on its items, and a sandboxed plan."""
    edi = 'C:\\Workspace.mioit\\Mio.EDI.Azure.Api'
    o = board(O, edi, 'waiting', 'orchestrate 24190', now=now)
    o.update(workItem='24190', waiting={'kind': 'plan', 'detail': 'Go-ahead for the plan for #24190, and 1 answer', 'since': now - 3 * MIN})
    o['plan'] = {
        'workItem': '24190', 'title': 'Completeness view', 'at': now - 3 * MIN,
        'gate': {'since': now - 3 * MIN, 'questions': ['Is the FileHorizon feed in place?']},
        'items': [
            {'workItem': '30277', 'title': 'Delivered lines', 'type': 'User Story', 'start': 'now', 'after': [], 'proposed': False, 'question': None, 'reason': ''},
            {'workItem': '30281', 'title': 'Modify first', 'type': 'Bug', 'start': 'now', 'after': [], 'proposed': False, 'question': None, 'reason': ''},
            {'workItem': '26219', 'title': 'Rows overlap', 'type': 'Bug', 'start': 'later', 'after': ['30281'], 'proposed': True, 'question': None, 'reason': ''},
            {'workItem': '29581', 'title': 'SFTP row', 'type': 'User Story', 'start': 'hold', 'after': [], 'proposed': False, 'question': 1, 'reason': ''},
            {'workItem': '26100', 'title': 'Docs', 'type': 'Task', 'start': 'skip', 'after': [], 'proposed': False, 'question': None, 'reason': 'tasks get no session'},
        ]}
    p = board(P, edi, 'running', 'deliver 30281', now=now)
    p.update(workItem='30281', skill={'name': 'work-item-delivery', 'args': '30281', 'at': now - 9 * MIN})
    q = board(Q, edi, 'idle', 'deliver 30277', now=now)
    q.update(workItem='30277', done={'at': now - 2 * MIN, 'note': 'merged'})
    y = board(Y, 'C:\\sandbox\\x', 'idle', 'boxed plan', now=now)
    y['plan'] = {'title': '<img src=x onerror=alert(1)>', 'gate': None,
                 'items': [{'workItem': '<b>1</b>', 'title': '"><script>bad()</script>', 'type': 'constructor', 'start': '<i>'}]}
    return [o, p, q], y


def busy(now):
    """A tile with every footer item, long names and more agents than fit."""
    b = board(G, 'C:\\Workspace.mioit\\Mio.BI.Services.Export', 'idle', 'Issue #30395 code-review delivery', now=now)
    b.update({
        'model': 'claude-opus-5-5[1m]', 'turns': 13, 'costUsd': 3.18,
        'context': {'percent': 10, 'tokens': 100_000, 'window': 1_000_000},
        'memory': {'mb': 700, 'wsMb': 500, 'childMb': 112, 'history': [[now - i * MIN, 700 + i * 9] for i in range(6)]},
        'cache': {'at': now - 2 * MIN, 'ttl': '1h'},
        'crons': [{'id': 'c1', 'human': 'every 30 minutes', 'nextAt': now + 12 * MIN, 'recurring': True, 'prompt': 'check CI'}],
        'shells': [{'id': 'b1', 'summary': 'npm test --watch', 'since': now - 3 * MIN}],
        'prs': [{'url': f'https://dev.azure.com/x/_git/r/pullrequest/{n}', 'repo': 'Mio.BI', 'number': n, 'host': 'ado'}
                for n in (37457, 37458)],
        'agents': [{'agentId': f'a{i}', 'type': t, 'status': st, 'description': t}
                   for i, (t, st) in enumerate([('general-purpose', 'idle'), ('wi-contract-review', 'done'),
                                                ('wi-story', 'done'), ('code-reviewer', 'done'), ('Explore', 'failed')])],
        'events': [{'t': now - (9 - i) * MIN, 'kind': 'tool', 'text': f'Bash · git push origin story/3039{i}'} for i in range(4)],
    })
    return b


def board(sid, cwd, state='idle', title=None, messages=(), events=(), now=0):
    return {
        'v': 1, 'sessionId': sid, 'interactive': True, 'cwd': cwd, 'project': cwd.split('\\')[-1], 'repo': None,
        'branch': 'main', 'tabTitle': title, 'model': None, 'startedAt': now - 60 * MIN, 'updatedAt': now + 3600_000,
        'state': state, 'stateSince': now - 5 * MIN, 'waiting': None, 'prompt': 'Fix the thing.', 'promptAt': now - 6 * MIN,
        'skill': None, 'activeSkill': None, 'workItem': None, 'prs': [], 'turns': 4, 'tools': [], 'agents': [],
        'events': list(events), 'context': None, 'costUsd': None, 'cache': None, 'memory': None, 'machine': None,
        'crons': [], 'shells': [], 'messages': list(messages), 'done': None,
    }


def envelope(name, pipe, body):
    return f'<cross-session-message from="uds:\\\\.\\pipe\\LOCAL\\cc-msg-{pipe}" from-name="{name}" from-mode="prompting"> {body}'


def write_boards(root: Path):
    now = int(time.time() * 1000)
    probe, reply = 'Probe from session-board-f4: reply with your id.', 'Probe reply: e8ada331, tag below.'
    sessions = [
        board(A, 'C:\\Workspace\\session-board', 'running', 'messages view', now=now, messages=[
            {'t': now - 4 * MIN, 'dir': 'out', 'peer': 'session-board-57', 'text': probe},
            {'t': now - 3 * MIN, 'dir': 'in', 'peer': 'session-board-57', 'address': 'uds:pipe57', 'text': reply}]),
        board(B, 'C:\\Workspace\\session-board', 'idle', 'speaking partner', now=now, messages=[
            {'t': now - 4 * MIN + 1000, 'dir': 'in', 'peer': 'session-board-f4', 'address': 'uds:pipef4', 'text': probe},
            {'t': now - 3 * MIN - 1000, 'dir': 'out', 'peer': 'session-board-f4', 'address': 'uds:pipef4', 'text': reply}]),
        board(C, 'C:\\Workspace.mioit\\resurslogs', 'background', 'drift-day', now=now),
        board(D, 'C:\\Workspace.mioit\\Mio.Finance.Resurs.Api', 'idle', 'drift fixes', now=now, events=[
            {'t': now - (50 - i * 9) * MIN, 'kind': 'prompt', 'text': envelope('resurslogs-0e', 'c0', f'Analyzer: verdict {i}')}
            for i in range(5)]),
        board(F, 'C:\\Workspace.mioit\\dotnet-upgrade-kit', 'idle', now=now, events=[
            {'t': now - 70 * MIN, 'kind': 'prompt', 'text': envelope('mio-m3-sales-c7', 'c7', 'Please check these work items')}]),
        busy(now),
        *plans(now)[0],
    ]
    (root / 'sessions').mkdir()
    for b in sessions:
        (root / 'sessions' / f"{b['sessionId']}.json").write_text(json.dumps(b), encoding='utf-8')
    # A sandboxed file may claim anything: it never joins the graph.
    (root / 'sandboxed').mkdir()
    fake = board(X, 'C:\\sandbox\\session-board', 'idle', 'boxed', now=now, messages=[
        {'t': now - 4 * MIN + 2000, 'dir': 'in', 'peer': 'session-board-f4', 'text': probe}])
    (root / 'sandboxed' / f'{X}.json').write_text(json.dumps(fake), encoding='utf-8')
    (root / 'sandboxed' / f'{Y}.json').write_text(json.dumps(plans(now)[1]), encoding='utf-8')
    shutil.copy(PAGE, root / 'index.html')


class Quiet(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


@unittest.skipIf(sync_playwright is None, 'Playwright is not installed: pip install playwright')
class MessagesView(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dir = tempfile.TemporaryDirectory()
        root = Path(cls.dir.name)
        write_boards(root)
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Quiet, directory=str(root)))
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.url = f'http://127.0.0.1:{cls.server.server_address[1]}/index.html'
        cls.pw = sync_playwright().start()
        cls.browser = None
        for channel in ('msedge', 'chrome', None):
            try:
                cls.browser = cls.pw.chromium.launch(channel=channel) if channel else cls.pw.chromium.launch()
                break
            except PlaywrightError:
                continue
        if cls.browser is None:
            cls.tearDownClass()
            raise unittest.SkipTest('no browser for Playwright: install Edge or Chrome, or run `playwright install chromium`')

    @classmethod
    def tearDownClass(cls):
        if getattr(cls, 'browser', None):
            cls.browser.close()
        cls.pw.stop()
        cls.server.shutdown()
        cls.server.server_close()
        cls.dir.cleanup()

    def setUp(self):
        self.page = self.browser.new_page(viewport={'width': 1400, 'height': 1000})
        self.errors = []
        self.page.on('pageerror', lambda e: self.errors.append(str(e)))
        self.page.goto(self.url)
        self.page.wait_for_selector(f'[data-session="{A}"]')

    def tearDown(self):
        self.page.close()
        self.assertEqual(self.errors, [])

    def tile(self, sid):
        return self.page.locator(f'.tile[data-session="{sid}"]')

    def open_messages(self):
        self.page.click('#msgs')
        self.page.wait_for_selector('.mgraph')
        self.settled()

    def settled(self):
        # The drawer slides in; a click mid-slide lands outside the viewport.
        self.page.wait_for_function("getComputedStyle(document.querySelector('.drawer')).transform === 'none'")

    def test_header_and_badges_count_messages(self):
        # A probe and its reply count once each, though both files record them.
        self.assertEqual(self.page.locator('#msgs').inner_text().strip(), '✉ 8 messages')
        self.assertEqual(self.tile(A).locator('.msg-badge').inner_text(), '✉ 2')
        self.assertEqual(self.tile(D).locator('.msg-badge').inner_text(), '✉ 5')
        self.assertIn('hot', self.tile(A).locator('.msg-badge').get_attribute('class'))
        self.assertEqual(self.tile(X).locator('.msg-badge').count(), 0)

    def test_an_old_receipt_reads_as_a_message_not_markup(self):
        slot = self.tile(D).locator('.slot').inner_text()
        self.assertIn('from resurslogs-0e: Analyzer: verdict 4', slot)
        self.assertNotIn('<cross-session-message', slot)

    def test_graph_matches_pairs_guesses_projects_and_keeps_strangers(self):
        self.open_messages()
        graph = self.page.locator('.mgraph')
        self.assertEqual(graph.locator('g.n').count(), 6)  # A, B, C, D, F, the stranger
        solid = graph.locator(f'g.e[data-msg-focus="{A}|{B}"] path.edge')
        self.assertEqual(solid.count(), 2)  # one arc each way
        for i in range(2):
            self.assertNotIn('guess', solid.nth(i).get_attribute('class'))
        guessed = graph.locator(f'g.e[data-msg-focus="{C}|{D}"] path.edge')
        self.assertIn('guess', guessed.get_attribute('class'))
        self.assertEqual(graph.locator('g.n.unknown').count(), 1)
        self.assertIn('mio-m3-sales-c7', graph.locator('g.n.unknown').text_content())

    def test_an_arrow_or_a_badge_narrows_the_list(self):
        self.open_messages()
        self.assertEqual(self.page.locator('.mmsg').count(), 8)
        # An arc's box centre is off the line: click the middle of the path itself.
        x, y = self.page.locator(f'g.e[data-msg-focus="{A}|{B}"] path.hit').first.evaluate(
            '(p) => { const m = p.getPointAtLength(p.getTotalLength() / 2).matrixTransform(p.getScreenCTM()); return [m.x, m.y] }')
        self.page.mouse.click(x, y)
        self.assertEqual(self.page.locator('.mmsg').count(), 2)
        self.assertIn('speaking partner', self.page.locator('.m-focus').inner_text())
        self.page.click('.m-focus [data-msg-focus=""]')
        self.assertEqual(self.page.locator('.mmsg').count(), 8)
        self.page.keyboard.press('Escape')
        self.tile(D).locator('.msg-badge').click()
        self.page.wait_for_selector('.m-focus')
        self.assertEqual(self.page.locator('.mmsg').count(), 5)

    def test_a_session_drawer_lists_its_messages(self):
        self.tile(B).click()
        self.page.wait_for_selector('#d-body .mlist')
        rows = self.page.locator('#d-body .mmsg')
        self.assertEqual(rows.count(), 2)
        self.assertIn('Probe reply', rows.first.inner_text())

    def test_a_plan_shows_above_its_orchestrator_with_each_items_session(self):
        plan = self.page.locator('.plan', has=self.page.locator('.p-by', has_text='orchestrate 24190'))
        self.assertIn('Waiting for your go and 1 answer', plan.locator('.p-gate').inner_text())
        rows = plan.locator('.p-row')
        self.assertEqual(rows.count(), 5)
        classes = [rows.nth(i).get_attribute('class').split()[1] for i in range(5)]
        self.assertEqual(classes, ['n-done', 'n-running', 'n-later', 'n-hold', 'n-skip'])
        self.assertIn('after #30281', rows.nth(2).inner_text())
        self.assertIn('proposed', rows.nth(2).inner_text())
        self.assertIn('Q1', rows.nth(3).inner_text())
        self.assertEqual(plan.locator('.p-rail path.proposed').count(), 1)
        self.assertIn('1 of 4 done', plan.locator('.p-tally').inner_text())
        # The orchestrator waits on the person, so the board counts it.
        self.assertIn('s-waiting', self.tile(O).get_attribute('class'))
        rows.nth(1).hover()
        self.assertIn('linked', self.tile(P).get_attribute('class'))
        rows.nth(1).click()
        self.settled()
        self.assertIn('30281', self.page.locator('#d-body').inner_text())

    def test_a_sandboxed_plan_renders_as_text(self):
        plan = self.page.locator('.plan', has=self.page.locator('.p-by', has_text='boxed plan'))
        self.assertEqual(plan.count(), 1)
        self.assertEqual(plan.locator('img, script, .p-row b, .p-row i').count(), 0)
        self.assertNotIn('<', plan.inner_text())
        self.assertEqual(plan.locator('.p-row .ty').text_content(), 'constructor')


    def test_a_full_tile_keeps_the_height_and_cuts_nothing(self):
        # 370px of viewport leaves the narrowest tile the grid allows.
        for width in (1400, 370):
            self.page.set_viewport_size({'width': width, 'height': 1000})
            # The +N chip shows, on the visible line of the agents row.
            self.page.wait_for_function(f'''(() => {{
                const m = document.querySelector('.tile[data-session="{G}"] .agent.more:not([hidden])')
                return m && m.getBoundingClientRect().bottom <= m.parentElement.getBoundingClientRect().bottom
            }})()''')
            heights = self.page.eval_on_selector_all('.tile', 'ts => ts.map((t) => t.offsetHeight)')
            self.assertEqual(len(set(heights)), 1, f'tile heights at {width}px: {heights}')
            # Every footer item and agent chip is either whole on its row or not shown at all.
            cut = self.tile(G).evaluate('''(t) => [...t.querySelectorAll('.f-row > *, .f-left > *, .prs > *, .agents > *')]
                .filter((el) => el.offsetParent && el.getClientRects().length)
                .filter((el) => { const r = el.getBoundingClientRect(), p = el.parentElement.getBoundingClientRect()
                  return r.top < p.bottom && (r.right > p.right + 0.5 || r.bottom > p.bottom + 0.5) })
                .map((el) => el.textContent.trim())''')
            self.assertEqual(cut, [], f'cut off at {width}px')
        more = self.tile(G).locator('.agent.more')
        self.assertRegex(more.inner_text(), r'^\+\d$')
        self.assertTrue(more.get_attribute('title'))


if __name__ == '__main__':
    unittest.main()
