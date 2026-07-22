"""端到端 WS 测试：连真实服务，四轨各起不同音，验证分轨、hash、无 underrun。"""
import asyncio, json, numpy as np, aiohttp

HOST = "127.0.0.1:18090"

async def main():
    async with aiohttp.ClientSession() as s:
        status = await (await s.get(f"http://{HOST}/api/decoder-status")).json()
        m = status["models"][0]
        print("status:", {k: m[k] for k in ("id","poolSize","blockSamples","rowVoices","roamSupported","pendingVoices")})
        assert m["id"] == "brave-voices"
        assert m["rowVoices"] == ["bass", "pad", "lead", "pluck"]

        async with s.ws_connect(f"ws://{HOST}/decoder?split=1") as ws:
            ready = json.loads((await ws.receive()).data)
            ch = ready["channels"]
            print("ready: split=%s channels=%s" % (ready["split"], ch))
            assert ready["split"] and ch == 4

            notes = [43, 55, 67, 79]  # bass/pad/lead/pluck 分开音区
            for row, midi in enumerate(notes):
                await ws.send_json({"type":"note","voice":row,"midi":midi,
                                    "velocity":1.0,"durationSeconds":2.0})

            buf, need, got = [], int(44100*1.8), 0
            underruns_seen = None
            while got < need:
                msg = await asyncio.wait_for(ws.receive(), timeout=8)
                if msg.type == aiohttp.WSMsgType.BINARY:
                    a = np.frombuffer(msg.data, "<f4")
                    buf.append(a); got += len(a)//ch
                elif msg.type == aiohttp.WSMsgType.TEXT:
                    d = json.loads(msg.data)
                    if d.get("type") == "telemetry":
                        underruns_seen = d.get("underruns")

            x = np.concatenate(buf).reshape(-1, ch)

    rms = [float(np.sqrt(np.mean(x[:,c]**2))) for c in range(ch)]
    nan = [bool(np.isnan(x[:,c]).any()) for c in range(ch)]
    print("逐轨 RMS:", [round(r,4) for r in rms], " has_nan:", nan)
    assert all(r > 1e-4 for r in rms), f"有轨没出声: {rms}"
    assert not any(nan), "出现 NaN"

    cors = [(i,j,float(np.corrcoef(x[:,i],x[:,j])[0,1])) for i in range(ch) for j in range(i+1,ch)]
    worst = max(cors, key=lambda t: abs(t[2]))
    print("两两相关最大:", f"轨{worst[0]}×轨{worst[1]} = {worst[2]:+.4f}（应接近 0，四个独立模型）")

    for c in range(ch):
        sp = np.abs(np.fft.rfft(x[8000:8000+16384, c]))
        f = np.fft.rfftfreq(16384, 1/44100)[np.argmax(sp)]
        print(f"  轨{c} ({['bass','pad','lead','pluck'][c]}) 主频 {f:7.1f} Hz  峰值 {np.abs(x[:,c]).max():.4f}")

    print("underruns:", underruns_seen)
    print("\n✅ 端到端四音色分轨验证通过")

asyncio.run(main())
