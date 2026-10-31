/**
 * 端口探测。
 *
 * 这里有两类测试：
 *   · 纯解析（parseListeningPorts）：喂一段 lsof 输出，验证解析规则；
 *   · 真绑端口（canBind / pickFreePort）：必须用真实的 socket 才有意义，
 *     所以端口号现场找 —— 写死 41000 这类数值只是"某台机器当时碰巧空着"。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import {
  isPortInUse, canBind, pickFreePort, isDoubaoEndpoint, parseListeningPorts,
} from '../src/port.mjs';

/** 在指定端口监听（不传就交给系统挑），返回真实端口 */
function listenOn(port = 0) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(port, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

const close = (srv) => new Promise((r) => srv.close(r));

/**
 * 找一段**连续 span 个都空闲**的端口。
 *
 * 从 40000 起按 span 步长往后扫，而不是 random：同样的机器给同样的结果，
 * 失败时能复现。写死具体数值更不行 —— 那只是某台机器当时碰巧空着。
 */
async function freePortBlock(span) {
  for (let base = 40000; base < 60000; base += span) {
    let allFree = true;
    for (let i = 0; i < span; i++) {
      if (!(await canBind(base + i))) { allFree = false; break; }
    }
    if (allFree) return base;
  }
  throw new Error(`从 40000 扫到 60000 都没找到 ${span} 个连号的空闲端口`);
}

/** 起一个假的 CDP 端点（只实现被用到的两个路径），返回端口 */
function fakeCdp(t, targets) {
  const srv = http.createServer((req, res) => {
    if (req.url === '/json/version') {
      res.setHeader('content-type', 'application/json');
      res.end('{"Browser":"Doubao/1.0"}');
      return;
    }
    if (req.url === '/json/list') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(targets));
      return;
    }
    res.statusCode = 404;
    res.end('');
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => {
      t.after(() => new Promise((r) => srv.close(r)));
      resolve(srv.address().port);
    });
  });
}

test('parseListeningPorts：IPv4 / IPv6 / 通配地址都能解析，重复端口只留一个', () => {
  const out = [
    'COMMAND     PID USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME',
    'Doubao      611 me     10u  IPv4 0x8a1b2c3d4e5f6a7b      0t0  TCP 127.0.0.1:9225 (LISTEN)',
    'Doubao      611 me     11u  IPv6 0x8a1b2c3d4e5f6a7c      0t0  TCP [::1]:42050 (LISTEN)',
    'Doubao      611 me     12u  IPv4 0x8a1b2c3d4e5f6a7d      0t0  TCP 127.0.0.1:9225 (LISTEN)',
    'Doubao      611 me     13u  IPv4 0x8a1b2c3d4e5f6a7e      0t0  TCP *:14013 (LISTEN)',
  ].join('\n');
  assert.deepEqual(parseListeningPorts(out), [9225, 14013, 42050]);
});

test('parseListeningPorts：空输出 / 只有表头 / 没有 LISTEN 行 → 空数组', () => {
  assert.deepEqual(parseListeningPorts(''), []);
  assert.deepEqual(parseListeningPorts(null), []);
  assert.deepEqual(parseListeningPorts('COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\n'), []);
  assert.deepEqual(
    parseListeningPorts('Doubao 1 me 4u IPv4 0x1 0t0 TCP 127.0.0.1:9225 (ESTABLISHED)\n'),
    [],
  );
});

test('被占用的端口：isPortInUse 为 true，canBind 为 false', async () => {
  const { srv, port } = await listenOn();
  try {
    assert.equal(isPortInUse(port), true);
    assert.equal(await canBind(port), false);
  } finally {
    await close(srv);
  }
});

test('释放后 canBind 恢复为 true', async () => {
  const { srv, port } = await listenOn();
  await close(srv);
  assert.equal(await canBind(port), true);
});

test('pickFreePort 返回的端口真的能绑', async () => {
  const base = await freePortBlock(5);
  const p = await pickFreePort(base, 5);
  assert.ok(p !== null, '连号 5 个都空闲，应该能返回一个');
  assert.ok(p >= base && p < base + 5, `返回的 ${p} 不在 ${base}..${base + 4} 里`);
  assert.equal(await canBind(p), true);
});

test('pickFreePort 会跳过被占用的端口', async () => {
  const base = await freePortBlock(5);
  const { srv, port } = await listenOn(base);
  try {
    const p = await pickFreePort(base, 5);
    assert.ok(p !== null);
    assert.notEqual(p, port, '不应返回已被占用的端口');
  } finally {
    await close(srv);
  }
});

test('pickFreePort 支持 exclude 排除已试过的端口', async () => {
  const base = await freePortBlock(3);
  const first = await pickFreePort(base, 3);
  const second = await pickFreePort(base, 3, [first]);
  assert.ok(first !== null && second !== null, '连号 3 个都空闲，两次都该有结果');
  assert.notEqual(second, first);
});

test('isDoubaoEndpoint：target 里有 doubao:// → 认它是豆包的 CDP', async (t) => {
  const port = await fakeCdp(t, [{ id: '1', url: 'doubao://chat/abc' }, { id: '2', url: 'https://www.doubao.com/' }]);
  assert.equal(await isDoubaoEndpoint(port), true);
});

test('isDoubaoEndpoint：端点能连但 target 不是豆包 → 不能误认', async (t) => {
  // 别的 Electron 应用也开调试端口，端口号猜不出来，只能靠 target 判定
  const port = await fakeCdp(t, [{ id: '1', url: 'https://example.com/' }]);
  assert.equal(await isDoubaoEndpoint(port), false);
});

test('isDoubaoEndpoint：target 列表为空 → false', async (t) => {
  const port = await fakeCdp(t, []);
  assert.equal(await isDoubaoEndpoint(port), false);
});

test('isDoubaoEndpoint：没人监听 → false，不抛异常', async (t) => {
  // 先占一个端口再放掉，拿到一个"刚空出来、肯定没人听"的端口号
  const { srv, port } = await listenOn();
  await close(srv);
  t.diagnostic(`探测无人监听的端口 ${port}`);
  assert.equal(await isDoubaoEndpoint(port, 300), false);
});
