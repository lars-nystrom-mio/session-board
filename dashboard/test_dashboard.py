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
S1 = 'dddddddd-0000-4000-8000-00000000000d'  # running, a Bash call past its limit
S2 = 'eeeeeeee-0000-4000-8000-00000000000e'  # running, nothing in flight and nothing new
S3 = 'ffffffff-0000-4000-8000-00000000000f'  # running, a Bash call well within its limit
S4 = 'dddddddd-1111-4000-8000-00000000000d'  # running, a long build that the test lets end
S5 = 'eeeeeeee-1111-4000-8000-00000000000e'  # running, a background agent's Bash past its limit
S6 = 'ffffffff-1111-4000-8000-00000000000f'  # running, a REPL script awaiting a test run


def stalls(now):
    """Two running sessions that look stalled and one that doesn't."""
    hung = board(S1, 'C:\\Workspace\\pipelines', 'running', 'watch build', now=now)
    hung['tools'] = [{'id': 't1', 'tool': 'Bash', 'summary': 'az pipelines runs show --wait', 'since': now - 25 * MIN}]
    quiet = board(S2, 'C:\\Workspace\\pipelines', 'running', 'gone quiet', now=now)
    quiet.update(stateSince=now - 15 * MIN, promptAt=now - 16 * MIN,
                 events=[{'t': now - 14 * MIN, 'kind': 'tool', 'text': 'Edit · main.py'}])
    build = board(S3, 'C:\\Workspace\\pipelines', 'running', 'long build', now=now)
    build.update(stateSince=now - 15 * MIN, promptAt=now - 16 * MIN)
    build['tools'] = [{'id': 't3', 'tool': 'Bash', 'summary': 'dotnet build', 'since': now - 12 * MIN}]
    ended = board(S4, 'C:\\Workspace\\pipelines', 'running', 'build ends', now=now)
    ended.update(stateSince=now - 15 * MIN, promptAt=now - 16 * MIN,
                 events=[{'t': now - 14 * MIN, 'kind': 'tool', 'text': 'Bash · dotnet build'}])
    ended['tools'] = [{'id': 't4', 'tool': 'Bash', 'summary': 'dotnet build', 'since': now - 14 * MIN}]
    bg = board(S5, 'C:\\Workspace\\pipelines', 'running', 'background watcher', now=now)
    bg['agents'] = [{'key': 'k5', 'agentId': 'bg5', 'type': 'general-purpose', 'description': 'watch', 'status': 'running', 'since': now - 26 * MIN}]
    bg['tools'] = [{'id': 't5', 'tool': 'Bash', 'summary': 'az pipelines runs show --wait', 'agentId': 'bg5', 'since': now - 25 * MIN}]
    repl = board(S6, 'C:\\Workspace\\pipelines', 'running', 'repl test run', now=now)
    repl['tools'] = [{'id': 't6', 'tool': 'REPL', 'summary': 'npm test', 'since': now - 7 * MIN}]
    return [hung, quiet, build, ended, bg, repl]


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
    p.update(workItem='30281', skill={'name': 'work-item-delivery', 'args': '30281', 'at': now - 9 * MIN},
             progress={'at': now - MIN, 'phase': 'Reviewing', 'step': 3, 'of': 7, 'workItem': '30281'})
    q = board(Q, edi, 'idle', 'deliver 30277', now=now)
    q.update(workItem='30277', done={'at': now - 2 * MIN, 'note': 'merged'},
             progress={'at': now - 3 * MIN, 'phase': 'Implementing', 'step': 9, 'of': 3})
    y = board(Y, 'C:\\sandbox\\x', 'idle', 'boxed plan', now=now)
    y['plan'] = {'title': '<img src=x onerror=alert(1)>', 'gate': None,
                 'items': [{'workItem': '<b>1</b>', 'title': '"><script>bad()</script>', 'type': 'constructor', 'start': '<i>'}]}
    y['progress'] = {'at': now, 'phase': '<img src=x onerror=alert(1)>', 'step': '<b>2</b>', 'of': 3}
    y['state'] = 'running'
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
        *stalls(now),
    ]
    # Today's totals: what each spent since its day baseline. See test_today_strip.
    today = write_boards.day = time.strftime('%Y-%m-%d')
    costs = {C: {'costUsd': 5.0, 'costDay': {'day': today, 'usd': 1.0}},
             D: {'costUsd': 7.0, 'startedAt': now - 48 * 3600_000},  # older hooks, from yesterday
             S3: {'costUsd': 3.0, 'costDay': {'day': '2000-01-01', 'usd': 1.0}},
             F: {'costUsd': 2.5, 'startedAt': now - 1000},
             G: {'costDay': {'day': today, 'usd': 0}}}
    for b in sessions:
        b.update(costs.get(b['sessionId'], {}))
    (root / 'sessions').mkdir()
    for b in sessions:
        (root / 'sessions' / f"{b['sessionId']}.json").write_text(json.dumps(b), encoding='utf-8')
    # A sandboxed file may claim anything: it never joins the graph.
    (root / 'sandboxed').mkdir()
    fake = board(X, 'C:\\sandbox\\session-board', 'idle', 'boxed', now=now, messages=[
        {'t': now - 4 * MIN + 2000, 'dir': 'in', 'peer': 'session-board-f4', 'text': probe}])
    # A sandbox claiming a cost: never counted.
    fake.update({'costUsd': 9.0, 'costDay': {'day': time.strftime('%Y-%m-%d'), 'usd': 0}})
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


    def test_a_reported_phase_wins_over_the_inferred_one(self):
        phase = self.tile(P).locator('.phase')
        self.assertIn('reported', phase.get_attribute('class'))
        self.assertEqual(phase.text_content(), 'Reviewing · 3/7 · #30281')
        # A sandboxed report renders as text, and a step that isn't a number is dropped.
        boxed = self.tile(Y).locator('.phase')
        self.assertEqual(self.tile(Y).locator('.title img').count(), 0)
        self.assertNotIn('<', boxed.text_content())
        self.assertNotIn('2', boxed.text_content())
        # Without a report the tile keeps the inferred phase.
        self.assertNotIn('reported', self.tile(G).locator('.title').inner_html())
        # An idle session's report may describe work that stopped: the tile drops it, the drawer keeps it.
        self.assertEqual(self.tile(Q).locator('.phase.reported').count(), 0)
        self.tile(Q).click()
        self.settled()
        self.assertIn('Implementing · step 9', self.page.locator('#d-body .progress').inner_text())

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

    def test_a_running_session_that_went_quiet_looks_stalled(self):
        self.assertIn('stalled', self.tile(S1).get_attribute('class'))
        self.assertTrue(self.tile(S1).locator('.since').inner_text().startswith('stalled · Bash 25m'))
        # Only the overdue tool is marked, and a tool in flight within its limit isn't a stall.
        self.assertEqual(self.tile(S1).locator('.act.over').count(), 1)
        for sid in (S3, S5, S6, A, P):
            self.assertNotIn('stalled', self.tile(sid).get_attribute('class'))
        # Its own colour, and the sweep stops.
        look = lambda sid: self.tile(sid).evaluate('''(t) => [getComputedStyle(t).borderTopColor,
            getComputedStyle(t, '::before').animationName, getComputedStyle(t.querySelector('.state-dot')).backgroundColor]''')
        stalled, healthy, waiting = look(S1), look(S3), look(O)
        self.assertEqual(stalled[1], 'none')
        self.assertEqual(healthy[1], 'sweep')
        for other in (healthy, waiting):
            self.assertNotEqual(stalled[0], other[0])
            self.assertNotEqual(stalled[2], other[2])
        self.tile(S1).click()
        self.settled()
        self.assertIn('looks stalled: Bash has run longer than 20 min', self.page.inner_text('#d-body'))

    def test_today_strip(self):
        # Spent since each day baseline: resurslogs 4.00, the busy tile 3.18, and
        # dotnet-upgrade-kit 2.50 (started today, no baseline). A baseline from
        # another day counts nothing; a file from yesterday without one and a
        # sandboxed file are left out. The fixture's dates are local days.
        t = time.localtime()
        if time.strftime('%Y-%m-%d', t) != write_boards.day or t.tm_hour * 60 + t.tm_min >= 23 * 60 + 58:
            self.skipTest('too close to midnight for the fixture')
        strip = self.page.locator('#today')
        tiles = self.page.locator('#groups .tile').count()
        waiting = self.page.locator('#groups .tile.s-waiting').count()
        text = ' '.join(strip.inner_text().split())
        self.assertIn('$9.68+', text)
        self.assertIn(f'{tiles} active', text)
        self.assertIn(f"{waiting} {'needs you' if waiting == 1 else 'need you'}", text)
        title = strip.locator('.cost').get_attribute('title')
        self.assertEqual(title.split('\n')[:4], ['By project:', 'resurslogs  $4.00', 'Mio.BI.Services.Export  $3.18', 'dotnet-upgrade-kit  $2.50'])
        self.assertIn('1 session from before today', title)
        self.assertIn('1 sandboxed session not counted', title)
        self.assertLess(strip.bounding_box()['y'], self.tile(A).bounding_box()['y'])

    def test_quiet_counts_from_when_the_page_first_saw_the_session(self):
        # The file's times can't tell whether a tool just ended, so a session
        # quiet for 14 minutes by its file only stalls after 10 minutes of watching.
        self.page.close()
        self.page = self.browser.new_page(viewport={'width': 1400, 'height': 1000})
        self.page.on('pageerror', lambda e: self.errors.append(str(e)))
        self.page.clock.install()
        self.page.goto(self.url)
        self.page.wait_for_selector(f'[data-session="{S2}"]')
        self.assertNotIn('stalled', self.tile(S2).get_attribute('class'))
        # The page redraws times on a 1 s interval that started before it saw
        # the session, so the last redraw within 11 minutes can fall just short
        # of 11 minutes after that sight. Two seconds more always reach it.
        self.page.clock.run_for(11 * MIN + 2_000)
        self.page.wait_for_function(f'''document.querySelector('.tile[data-session="{S2}"]').classList.contains('stalled')''')
        self.assertTrue(self.tile(S2).locator('.since').inner_text().startswith('stalled · quiet 11m'))

    def test_a_streamed_answer_counts_as_activity(self):
        # No tool in flight for 12 minutes, but the model streamed 6 minutes in:
        # lastStepAt moved on, so the page saw something new and doesn't stall.
        path = Path(self.dir.name) / 'sessions' / f'{S2}.json'
        before = path.read_text(encoding='utf-8')
        self.page.close()
        self.page = self.browser.new_page(viewport={'width': 1400, 'height': 1000})
        self.page.on('pageerror', lambda e: self.errors.append(str(e)))
        self.page.clock.install()
        self.page.goto(self.url)
        self.page.wait_for_selector(f'[data-session="{S2}"]')
        try:
            self.page.clock.run_for(6 * MIN)
            self.page.wait_for_timeout(500)
            b = json.loads(before)
            b['lastStepAt'] = b['updatedAt'] + 6 * MIN
            path.write_text(json.dumps(b), encoding='utf-8')
            self.page.clock.run_for(3_000)  # the next poll reads it
            self.page.wait_for_timeout(1000)
            self.page.clock.run_for(6 * MIN)
            self.page.wait_for_timeout(500)
            self.assertNotIn('stalled', self.tile(S2).get_attribute('class'))
        finally:
            path.write_text(before, encoding='utf-8')

    def test_a_tool_that_ends_counts_as_activity(self):
        # The build ends: it leaves `tools` and writes no event, so the file's
        # newest time is 14 minutes old. The page saw the change, so no stall.
        path = Path(self.dir.name) / 'sessions' / f'{S4}.json'
        b = json.loads(path.read_text(encoding='utf-8'))
        before = dict(b)
        b['tools'] = []
        path.write_text(json.dumps(b), encoding='utf-8')
        try:
            self.page.wait_for_function(f'''!document.querySelector('.tile[data-session="{S4}"] .act:not(.past):not(.last)')''')
            self.page.wait_for_timeout(2500)
            self.assertNotIn('stalled', self.tile(S4).get_attribute('class'))
        finally:
            path.write_text(json.dumps(before), encoding='utf-8')

    # Desktop notifications, with the browser's Notification API stubbed out.
    STUB = '''(() => {
        window.notes = []
        class N {
            constructor(title, opts) { this.title = title; this.body = opts.body; this.tag = opts.tag; notes.push(this) }
            close() { this.closed = true }
        }
        N.permission = localStorage.getItem('test.perm') || 'granted'
        N.requestPermission = async () => (N.permission = 'granted')
        window.Notification = N
    })()'''

    def notify_page(self, perm='granted', **stored):
        self.page.close()
        self.page = self.browser.new_page(viewport={'width': 1400, 'height': 1000})
        self.page.on('pageerror', lambda e: self.errors.append(str(e)))
        sets = ''.join(f"localStorage.setItem('{k}', '{v}');" for k, v in {'test.perm': perm, **stored}.items())
        self.page.add_init_script(f'(() => {{ {sets} }})()')
        self.page.add_init_script(self.STUB)
        self.page.goto(self.url)
        self.page.wait_for_selector(f'[data-session="{A}"]')
        self.page.wait_for_timeout(300)

    def rewrite(self, sid, **changes):
        path = Path(self.dir.name) / 'sessions' / f'{sid}.json'
        before = path.read_text(encoding='utf-8')
        b = json.loads(before)
        b.update(changes)
        path.write_text(json.dumps(b), encoding='utf-8')
        self.addCleanup(path.write_text, before, encoding='utf-8')

    def notes(self):
        return self.page.evaluate('notes.map((n) => ({title: n.title, body: n.body}))')

    def test_a_session_that_starts_waiting_notifies_once_and_opens_its_drawer(self):
        self.notify_page()
        # O was already waiting on load: no notification for it.
        self.assertEqual(self.notes(), [])
        now = int(time.time() * 1000)
        self.rewrite(F, state='waiting', stateSince=now, tabTitle='upgrade kit',
                     waiting={'kind': 'question', 'detail': 'Which .NET version?', 'since': now})
        self.page.wait_for_function('notes.length > 0')
        self.page.wait_for_timeout(2500)  # another poll: still one
        self.assertEqual(self.notes(), [{'title': 'Needs you: dotnet-upgrade-kit · upgrade kit',
                                         'body': 'Has a question: Which .NET version?'}])
        self.page.evaluate('notes[0].onclick()')
        self.settled()
        self.assertTrue(self.page.evaluate('notes[0].closed'))
        self.assertIn('dotnet-upgrade-kit', self.page.inner_text('#d-sub'))
        self.assertIn('Which .NET version?', self.page.inner_text('#d-body'))

    def test_mute_silences_notifications_and_is_remembered(self):
        self.notify_page()
        self.page.click('#notify-mute')
        self.assertEqual(self.page.get_attribute('#notify-mute', 'aria-pressed'), 'true')
        self.assertEqual(self.page.evaluate("localStorage.getItem('sessionBoard.notifyMute')"), '1')
        now = int(time.time() * 1000)
        self.rewrite(F, state='waiting', stateSince=now, waiting={'kind': 'plan', 'detail': 'Go?', 'since': now})
        self.page.wait_for_selector(f'.tile[data-session="{F}"] .ask')
        self.page.wait_for_timeout(500)
        self.assertEqual(self.notes(), [])

    def test_a_long_turn_that_ends_notifies_only_when_asked_for(self):
        # Off by default: S3's 15-minute turn ends without a notification.
        self.notify_page()
        self.assertEqual(self.page.get_attribute('#notify-long', 'aria-pressed'), 'false')
        now = int(time.time() * 1000)
        self.rewrite(S3, state='idle', stateSince=now, tools=[])
        self.page.wait_for_function(f'''document.querySelector('.tile[data-session="{S3}"] .since').textContent.startsWith('idle')''')
        self.page.wait_for_timeout(2500)
        self.assertEqual(self.notes(), [])
        # Turned on: S4's ends and notifies, with how long it ran.
        self.page.click('#notify-long')
        self.assertEqual(self.page.evaluate("localStorage.getItem('sessionBoard.notifyLong')"), '1')
        self.rewrite(S4, state='idle', stateSince=int(time.time() * 1000), tools=[])
        self.page.wait_for_function('notes.length > 0')
        [note] = self.notes()
        self.assertEqual(note['title'], 'Turn ended: pipelines · build ends')
        self.assertRegex(note['body'], r'^Ran 15m( \d\ds)? · Fix the thing\.$')

    def test_a_sandboxed_session_never_notifies(self):
        self.notify_page()
        path = Path(self.dir.name) / 'sandboxed' / f'{X}.json'
        before = path.read_text(encoding='utf-8')
        self.addCleanup(path.write_text, before, encoding='utf-8')
        b = json.loads(before)
        now = int(time.time() * 1000)
        b.update(state='waiting', stateSince=now, waiting={'kind': 'plan', 'detail': 'Approve deploy', 'since': now})
        path.write_text(json.dumps(b), encoding='utf-8')
        self.page.wait_for_selector(f'.tile[data-session="{X}"] .ask')
        self.page.wait_for_timeout(500)
        self.assertEqual(self.notes(), [])

    def test_a_turn_counts_its_background_agents_but_not_a_wait_for_you(self):
        self.notify_page(**{'sessionBoard.notifyLong': '1'})
        now = int(time.time() * 1000)
        # S3 ran 15 minutes, then waits for you: no "turn ended", and the wait doesn't count.
        self.rewrite(S3, state='waiting', stateSince=now, tools=[], waiting={'kind': 'question', 'detail': 'Which?', 'since': now})
        self.page.wait_for_function('notes.length === 1')
        later = now + 40 * MIN
        self.rewrite(S3, state='running', stateSince=later, waiting=None)
        self.page.wait_for_function(f'''document.querySelector('.tile[data-session="{S3}"] .since').textContent.includes('running')''')
        # Agents still run after the main loop stops: the turn goes on.
        self.rewrite(S3, state='background', stateSince=later + MIN)
        self.page.wait_for_function(f'''document.querySelector('.tile[data-session="{S3}"] .since').textContent.includes('agents')''')
        self.page.wait_for_timeout(500)
        self.assertEqual(len(self.notes()), 1)
        self.rewrite(S3, state='idle', stateSince=later + 3 * MIN)
        self.page.wait_for_function('notes.length === 2')
        note = self.notes()[1]
        self.assertEqual(note['title'], 'Turn ended: pipelines · long build')
        self.assertRegex(note['body'], r'^Ran 18m( \d\ds)? · Fix the thing\.$')

    def test_a_plan_gate_notifies_once_through_short_turns(self):
        self.notify_page()
        now = int(time.time() * 1000)
        gate = {'kind': 'plan', 'detail': 'Go-ahead for the plan', 'since': now - 10 * MIN}
        # Set before the page loaded, but the page sees the session start waiting on it.
        self.rewrite(S6, state='waiting', stateSince=now, tools=[], waiting=gate,
                     plan={'items': [], 'gate': {'since': now - 10 * MIN, 'questions': []}})
        self.page.wait_for_function('notes.length === 1')
        # A message starts a short turn; the gate comes back with the same since.
        self.rewrite(S6, state='running', stateSince=now + 1000, waiting=None, turns=5)
        self.page.wait_for_function(f'''document.querySelector('.tile[data-session="{S6}"] .since').textContent.includes('running')''')
        self.rewrite(S6, state='waiting', stateSince=now + 20_000, waiting=gate)
        self.page.wait_for_selector(f'.tile[data-session="{S6}"] .ask')
        self.page.wait_for_timeout(2500)
        self.assertEqual([n['title'] for n in self.notes()], ['Needs you: pipelines · repl test run'])

    def test_permission_is_asked_from_the_button_not_on_load(self):
        self.notify_page(perm='default')
        self.assertTrue(self.page.is_visible('#notify-ask'))
        self.assertFalse(self.page.is_visible('#notify-mute'))
        self.page.click('#notify-ask')
        self.page.wait_for_selector('#notify-mute', state='visible')
        self.assertFalse(self.page.is_visible('#notify-ask'))


if __name__ == '__main__':
    unittest.main()
