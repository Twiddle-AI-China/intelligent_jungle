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
