#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ghsync.py —— GitHub 差值同步工具

为什么需要它：
  沙盒的 git 协议被代理拦截（github.com 返回 403），git push / ls-remote 都用不了，
  但 api.github.com 是通的，所以改用 Git Data API 提交。

"差值"体现在两处，都不需要上传文件内容：
  1. 只处理变化的文件 —— 用 Git blob 的 SHA-1 比对（SHA-1 由内容决定，
     本地就能算出来，与线上 sha 相同即代表内容一致，直接跳过）。
  2. 删除项只需提交路径 + sha=null —— 同样不传内容。

用法：
    GHTOK=ghp_xxx python3 tools/ghsync.py                 # 同步当前目录（交互式确认）
    GHTOK=ghp_xxx python3 tools/ghsync.py --yes           # 不确认，直接提交
    GHTOK=ghp_xxx python3 tools/ghsync.py --dry           # 只看差异，不提交
    GHTOK=ghp_xxx python3 tools/ghsync.py --msg "说明"     # 自定义提交信息

可选参数：
    --repo  owner/name     默认 liuyiming2024/Chat
    --branch NAME          默认 main
    --root  DIR            默认脚本所在目录的上级（即仓库根）
    --include-workflows    一并处理 .github/workflows/（需要 token 带 workflow 权限）
    --no-delete            只增改，不删除线上多出的文件
"""
import json, urllib.request, urllib.error, ssl, os, sys, hashlib, base64

# ---------------- 参数 ----------------
argv = sys.argv[1:]
def opt(name, default=None):
    return default if name not in argv else (argv[argv.index(name) + 1] if argv.index(name) + 1 < len(argv) else default)

REPO   = opt('--repo', 'liuyiming2024/Chat')
BRANCH = opt('--branch', 'main')
ROOT   = opt('--root', os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DRY    = '--dry' in argv
YES    = '--yes' in argv
NODEL  = '--no-delete' in argv
WF     = '--include-workflows' in argv
MSG    = opt('--msg', None)

OWNER, REPON = REPO.split('/')
TOKEN = os.environ.get('GHTOK') or os.environ.get('GITHUB_TOKEN')
if not TOKEN:
    print('缺少 token：请设置环境变量 GHTOK'); sys.exit(1)

ctx = ssl.create_default_context()
def api(path, method='GET', data=None):
    req = urllib.request.Request('https://api.github.com' + path, method=method,
        data=json.dumps(data).encode() if data is not None else None,
        headers={'User-Agent': 'ghsync', 'Accept': 'application/vnd.github+json',
                 'Authorization': 'Bearer ' + TOKEN,
                 'X-GitHub-Api-Version': '2022-11-28'})
    try:
        with urllib.request.urlopen(req, timeout=60, context=ctx) as r:
            b = r.read().decode('utf-8', 'replace')
            return r.status, (json.loads(b) if b.strip().startswith(('{', '[')) else b)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode('utf-8', 'replace')[:400]
    except Exception as e:
        return 0, str(e)

# ---------------- 本地文件 ----------------
SKIP_DIRS = {'.git', 'node_modules', '__pycache__', 'data'}
def git_blob_sha(data: bytes) -> str:
    """Git blob 的 SHA-1：sha1("blob <len>\\0" + 内容)。内容不变则值不变。"""
    h = hashlib.sha1()
    h.update(b'blob %d\0' % len(data))
    h.update(data)
    return h.hexdigest()

local = {}
for dp, dns, fns in os.walk(ROOT):
    dns[:] = [d for d in dns if d not in SKIP_DIRS]
    for fn in fns:
        fp = os.path.join(dp, fn)
        rel = os.path.relpath(fp, ROOT).replace(os.sep, '/')
        if rel.startswith('.github/workflows/') and not WF:
            continue
        try:
            with open(fp, 'rb') as f:
                local[rel] = f.read()
        except Exception as e:
            print('  跳过（读取失败）', rel, e)

# ---------------- 线上文件 ----------------
code, ref = api('/repos/%s/%s/git/ref/heads/%s' % (OWNER, REPON, BRANCH))
if code != 200:
    print('读取分支失败', code, ref); sys.exit(1)
head_sha = ref['object']['sha']

code, tree = api('/repos/%s/%s/git/trees/%s?recursive=1' % (OWNER, REPON, BRANCH))
if code != 200:
    print('读取文件树失败', code, tree); sys.exit(1)
remote = {t['path']: t['sha'] for t in tree.get('tree', []) if t['type'] == 'blob'}

# ---------------- 比对 ----------------
add, mod, dele = [], [], []
for p, data in sorted(local.items()):
    if p not in remote:
        add.append(p)
    elif git_blob_sha(data) != remote[p]:
        mod.append(p)
if not NODEL:
    dele = sorted(set(remote) - set(local))

total_bytes = sum(len(local[p]) for p in add + mod)

print('仓库：%s  分支：%s' % (REPO, BRANCH))
print('HEAD ：%s' % head_sha[:10])
print('本地 %d 个文件 · 线上 %d 个文件' % (len(local), len(remote)))
print()
print('新增 %d：' % len(add))
for p in add:    print('   + %-42s %7d B' % (p, len(local[p])))
print('变更 %d：' % len(mod))
for p in mod:    print('   ~ %-42s %7d B' % (p, len(local[p])))
print('删除 %d：' % len(dele))
for p in dele:   print('   - %s' % p)
print()
unchanged = len(local) - len(add) - len(mod)
print('未变化 %d 个（内容一致，不上传）' % unchanged)
print('实际传输 %d 个文件，共 %.1f KB' % (len(add) + len(mod), total_bytes / 1024))

if DRY:
    print('\n--dry 模式，未提交'); sys.exit(0)
if not (add or mod or dele):
    print('\n无变化，无需提交'); sys.exit(0)
if not YES:
    try:
        ans = input('\n确认提交？[y/N] ').strip().lower()
    except EOFError:
        ans = 'n'
    if ans != 'y':
        print('已取消'); sys.exit(0)

# ---------------- 建 blob（只针对变化的） ----------------
code, cm = api('/repos/%s/%s/git/commits/%s' % (OWNER, REPON, head_sha))
base_tree = cm['tree']['sha']

entries, fail = [], []
for p in add + mod:
    code, b = api('/repos/%s/%s/git/blobs' % (OWNER, REPON), 'POST',
                  {'content': base64.b64encode(local[p]).decode(), 'encoding': 'base64'})
    if code not in (200, 201):
        fail.append((p, code)); continue
    entries.append({'path': p,
                    'mode': '100755' if p.endswith('.sh') else '100644',
                    'type': 'blob', 'sha': b['sha']})
for p in dele:
    entries.append({'path': p, 'mode': '100644', 'type': 'blob', 'sha': None})

if fail:
    print('blob 创建失败：', fail)
print('\n上传 blob %d 个（失败 %d）' % (len(add) + len(mod) - len(fail), len(fail)))

code, t = api('/repos/%s/%s/git/trees' % (OWNER, REPON), 'POST',
              {'base_tree': base_tree, 'tree': entries})
if code not in (200, 201):
    print('tree 失败', code, str(t)[:400]); sys.exit(1)

if not MSG:
    MSG = '更新 %d 个文件' % (len(add) + len(mod))
    if mod: MSG += '（变更 %d）' % len(mod)
    if add: MSG += '（新增 %d）' % len(add)
    if dele: MSG += '，删除 %d' % len(dele)

code, c = api('/repos/%s/%s/git/commits' % (OWNER, REPON), 'POST',
              {'message': MSG, 'tree': t['sha'], 'parents': [head_sha]})
if code not in (200, 201):
    print('commit 失败', code, str(c)[:400]); sys.exit(1)

code, u = api('/repos/%s/%s/git/refs/heads/%s' % (OWNER, REPON, BRANCH), 'PATCH', {'sha': c['sha']})
if code != 200:
    print('更新分支失败', code, str(u)[:300]); sys.exit(1)

print('提交完成：%s' % c['sha'][:10])
print('网址：https://%s.github.io/%s/' % (OWNER, REPON))
