# Native macOS alpha

The core engine builds without JUCE or network access:

```bash
cmake -S native -B build/native
cmake --build build/native
ctest --test-dir build/native --output-on-failure
```

The standalone app fetches the pinned JUCE 8.0.13 release:

```bash
cmake -S native -B build/native-app -DLCS_BUILD_APP=ON
cmake --build build/native-app --target LatentCosmos
```

Until a BRAVE model passes the bake-off and a real backend is connected, the app intentionally outputs silence and labels the decoder offline. `SilentDecoder` must never be treated as a passed audio milestone.

`RealtimeDecoderWorker` is the integration boundary for the next stage. It provides a fixed-capacity SPSC control queue, background-only `DecoderKernel`, preallocated stereo audio ring and explicit control-drop/underrun/overrun counters. The production app deliberately continues to instantiate `SilentDecoder`; the test kernel exists only in the native test executable.
