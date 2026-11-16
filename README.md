# 三段式入侵链的时间窗关联

一次入侵横跨三段时间：先爆破拿到账号，再上传 webshell，最后用 DNS 把数据带出去。

```
logs/auth.log   875 行（合成，含 3 起真实事件）
labels.json     3 个标注事件
detector/detector.py  基线检测器
tests/          骨架测试
```

## Run

```bash
python -m pytest tests -q
python detector/detector.py logs/auth.log findings.json
```

## 基线状态

`detector/detector.py` 对每条失败登录和每个请求各产出一条告警，不做任何关联：
不看失败之后有没有成功登录，不看同账号是否跨主机，也不看请求路径是否敏感。

## 标注事件

| kind | 说明 |
|---|---|
| `brute_force_success` | 暴力破解后成功登录 |
| `webshell` | 上传后执行 webshell |
| `dns_tunnel` | DNS 隧道外传 |

日志里另有故意放入的**良性相似流量**（少量失败后成功、被拒绝的少量探测），任何命中都算误报。
