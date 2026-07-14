#pragma once

#include "DecoderBackend.h"

#include <array>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <memory>
#include <span>
#include <thread>
#include <vector>

namespace lcs {

constexpr std::size_t maximumDecoderVoices = 12;

struct DecoderWorkerStats {
    std::uint64_t controlDrops{};
    std::uint64_t audioUnderruns{};
    std::uint64_t audioOverruns{};
    std::uint64_t decodedBlocks{};
};

// Implementations own model loading, 44.1 -> host-rate conversion and decoder
// state. prepare/decode are called only by the background worker, never by the
// audio callback.
class DecoderKernel {
public:
    virtual ~DecoderKernel() = default;
    virtual bool prepare(double hostSampleRate, std::size_t blockSize, std::size_t voices) = 0;
    virtual bool decode(std::span<const ControlFrame> controls,
                        float* left,
                        float* right,
                        std::size_t samples) noexcept = 0;
    virtual const char* description() const noexcept = 0;
};

class RealtimeDecoderWorker final : public DecoderBackend {
public:
    explicit RealtimeDecoderWorker(std::unique_ptr<DecoderKernel> kernel);
    ~RealtimeDecoderWorker() override;

    RealtimeDecoderWorker(const RealtimeDecoderWorker&) = delete;
    RealtimeDecoderWorker& operator=(const RealtimeDecoderWorker&) = delete;

    bool initialise(double sampleRate, std::size_t maximumBlockSize, std::size_t voices) override;
    void submit(std::span<const ControlFrame> frames) noexcept override;
    bool render(float* left, float* right, std::size_t samples) noexcept override;
    const char* status() const noexcept override;

    [[nodiscard]] DecoderWorkerStats stats() const noexcept;
    void stop() noexcept;

private:
    struct ControlPacket {
        std::array<ControlFrame, maximumDecoderVoices> frames{};
        std::size_t count{};
        std::uint64_t sequence{};
    };

    struct StereoSample { float left{}; float right{}; };

    static constexpr std::size_t controlQueueCapacity = 16;
    static constexpr std::size_t audioBufferBlocks = 4;

    bool pushControl(const ControlPacket& packet) noexcept;
    bool popControl(ControlPacket& packet) noexcept;
    std::size_t readableAudioFrames() const noexcept;
    std::size_t writableAudioFrames() const noexcept;
    bool pushAudioBlock(const float* left, const float* right, std::size_t samples) noexcept;
    std::size_t popAudio(float* left, float* right, std::size_t samples) noexcept;
    void workerLoop() noexcept;

    enum class State : std::uint8_t { offline, starting, running, kernelError, stopped };

    std::unique_ptr<DecoderKernel> kernel_;
    std::array<ControlPacket, controlQueueCapacity> controlQueue_{};
    std::atomic<std::size_t> controlWrite_{};
    std::atomic<std::size_t> controlRead_{};
    std::atomic<std::uint64_t> nextSequence_{};

    std::vector<StereoSample> audioRing_;
    std::atomic<std::size_t> audioWrite_{};
    std::atomic<std::size_t> audioRead_{};
    std::vector<float> workLeft_;
    std::vector<float> workRight_;
    std::size_t blockSize_{};
    std::size_t voiceCount_{};
    double sampleRate_{};

    std::atomic<bool> shouldRun_{};
    std::atomic<State> state_{State::offline};
    std::thread worker_;

    std::atomic<std::uint64_t> controlDrops_{};
    std::atomic<std::uint64_t> audioUnderruns_{};
    std::atomic<std::uint64_t> audioOverruns_{};
    std::atomic<std::uint64_t> decodedBlocks_{};
};

} // namespace lcs
