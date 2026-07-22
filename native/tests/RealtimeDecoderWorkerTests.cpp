#include "lcs/RealtimeDecoderWorker.h"

#include <algorithm>
#include <array>
#include <cassert>
#include <chrono>
#include <cmath>
#include <memory>
#include <thread>

namespace {
class TestKernel final : public lcs::DecoderKernel {
public:
    bool prepare(double sampleRate, std::size_t blockSize, std::size_t voices) override {
        return sampleRate == 48000.0 && blockSize == 64 && voices == 6;
    }

    bool decode(std::span<const lcs::ControlFrame> controls, float* left, float* right, std::size_t samples) noexcept override {
        const float value = controls.empty() ? 0.0f : controls.front().energy;
        for (std::size_t index = 0; index < samples; ++index) {
            left[index] = value;
            right[index] = -value;
        }
        return true;
    }

    const char* description() const noexcept override { return "test kernel"; }
};
} // namespace

int main() {
    lcs::RealtimeDecoderWorker worker(std::make_unique<TestKernel>());
    assert(worker.initialise(48000.0, 64, 6));

    std::array<lcs::ControlFrame, 6> controls{};
    controls[0].energy = 0.375f;
    worker.submit(controls);

    std::array<float, 64> left{};
    std::array<float, 64> right{};
    bool rendered = false;
    for (int attempt = 0; attempt < 100 && !rendered; ++attempt) {
        std::this_thread::sleep_for(std::chrono::milliseconds(2));
        rendered = worker.render(left.data(), right.data(), left.size());
    }
    assert(rendered);
    assert(std::abs(left[0] - 0.375f) < 1.0e-6f);
    assert(std::abs(right[0] + 0.375f) < 1.0e-6f);
    assert(worker.stats().decodedBlocks > 0);

    worker.stop();
    assert(!worker.render(left.data(), right.data(), left.size()));
    assert(std::all_of(left.begin(), left.end(), [](float value) { return value == 0.0f; }));
    assert(std::all_of(right.begin(), right.end(), [](float value) { return value == 0.0f; }));
    return 0;
}
