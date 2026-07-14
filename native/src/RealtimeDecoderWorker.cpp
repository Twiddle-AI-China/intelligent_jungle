#include "lcs/RealtimeDecoderWorker.h"

#include <algorithm>
#include <utility>

namespace lcs {

RealtimeDecoderWorker::RealtimeDecoderWorker(std::unique_ptr<DecoderKernel> kernel)
    : kernel_(std::move(kernel)) {}

RealtimeDecoderWorker::~RealtimeDecoderWorker() { stop(); }

bool RealtimeDecoderWorker::initialise(double sampleRate, std::size_t maximumBlockSize, std::size_t voices) {
    stop();
    if (!kernel_ || sampleRate <= 0 || maximumBlockSize == 0 || voices == 0 || voices > maximumDecoderVoices) {
        state_.store(State::kernelError, std::memory_order_release);
        return false;
    }

    sampleRate_ = sampleRate;
    blockSize_ = maximumBlockSize;
    voiceCount_ = voices;
    // Four blocks bound queueing latency while absorbing short worker jitter.
    // The target gate still includes this exact buffering contribution.
    audioRing_.assign(blockSize_ * audioBufferBlocks + 1, {});
    workLeft_.assign(blockSize_, 0.0f);
    workRight_.assign(blockSize_, 0.0f);
    audioWrite_.store(0, std::memory_order_relaxed);
    audioRead_.store(0, std::memory_order_relaxed);
    controlWrite_.store(0, std::memory_order_relaxed);
    controlRead_.store(0, std::memory_order_relaxed);
    nextSequence_.store(0, std::memory_order_relaxed);
    controlDrops_.store(0, std::memory_order_relaxed);
    audioUnderruns_.store(0, std::memory_order_relaxed);
    audioOverruns_.store(0, std::memory_order_relaxed);
    decodedBlocks_.store(0, std::memory_order_relaxed);

    state_.store(State::starting, std::memory_order_release);
    shouldRun_.store(true, std::memory_order_release);
    worker_ = std::thread(&RealtimeDecoderWorker::workerLoop, this);
    return true;
}

void RealtimeDecoderWorker::submit(std::span<const ControlFrame> frames) noexcept {
    if (!shouldRun_.load(std::memory_order_acquire)) return;
    ControlPacket packet;
    packet.count = std::min(frames.size(), packet.frames.size());
    std::copy_n(frames.begin(), packet.count, packet.frames.begin());
    packet.sequence = nextSequence_.fetch_add(1, std::memory_order_relaxed);
    if (!pushControl(packet)) controlDrops_.fetch_add(1, std::memory_order_relaxed);
}

bool RealtimeDecoderWorker::render(float* left, float* right, std::size_t samples) noexcept {
    if (!left || !right || samples == 0) return false;
    if (state_.load(std::memory_order_acquire) != State::running) {
        std::fill(left, left + samples, 0.0f);
        std::fill(right, right + samples, 0.0f);
        return false;
    }
    const auto popped = popAudio(left, right, samples);
    if (popped < samples || state_.load(std::memory_order_acquire) != State::running) {
        std::fill(left + popped, left + samples, 0.0f);
        std::fill(right + popped, right + samples, 0.0f);
        if (state_.load(std::memory_order_acquire) != State::running) {
            std::fill(left, left + popped, 0.0f);
            std::fill(right, right + popped, 0.0f);
        }
        audioUnderruns_.fetch_add(1, std::memory_order_relaxed);
        return false;
    }
    return true;
}

const char* RealtimeDecoderWorker::status() const noexcept {
    switch (state_.load(std::memory_order_acquire)) {
        case State::starting: return "DECODER WORKER STARTING";
        case State::running: return "DECODER WORKER RUNNING";
        case State::kernelError: return "DECODER KERNEL ERROR -- OUTPUT MUTED";
        case State::stopped: return "DECODER WORKER STOPPED -- OUTPUT MUTED";
        case State::offline: default: return "DECODER OFFLINE -- OUTPUT MUTED";
    }
}

DecoderWorkerStats RealtimeDecoderWorker::stats() const noexcept {
    return {
        controlDrops_.load(std::memory_order_relaxed),
        audioUnderruns_.load(std::memory_order_relaxed),
        audioOverruns_.load(std::memory_order_relaxed),
        decodedBlocks_.load(std::memory_order_relaxed),
    };
}

void RealtimeDecoderWorker::stop() noexcept {
    shouldRun_.store(false, std::memory_order_release);
    if (worker_.joinable()) worker_.join();
    if (state_.load(std::memory_order_acquire) != State::kernelError)
        state_.store(State::stopped, std::memory_order_release);
}

bool RealtimeDecoderWorker::pushControl(const ControlPacket& packet) noexcept {
    const auto write = controlWrite_.load(std::memory_order_relaxed);
    const auto next = (write + 1) % controlQueue_.size();
    if (next == controlRead_.load(std::memory_order_acquire)) return false;
    controlQueue_[write] = packet;
    controlWrite_.store(next, std::memory_order_release);
    return true;
}

bool RealtimeDecoderWorker::popControl(ControlPacket& packet) noexcept {
    const auto read = controlRead_.load(std::memory_order_relaxed);
    if (read == controlWrite_.load(std::memory_order_acquire)) return false;
    packet = controlQueue_[read];
    controlRead_.store((read + 1) % controlQueue_.size(), std::memory_order_release);
    return true;
}

std::size_t RealtimeDecoderWorker::readableAudioFrames() const noexcept {
    const auto write = audioWrite_.load(std::memory_order_acquire);
    const auto read = audioRead_.load(std::memory_order_acquire);
    return write >= read ? write - read : audioRing_.size() - read + write;
}

std::size_t RealtimeDecoderWorker::writableAudioFrames() const noexcept {
    return audioRing_.empty() ? 0 : audioRing_.size() - 1 - readableAudioFrames();
}

bool RealtimeDecoderWorker::pushAudioBlock(const float* left, const float* right, std::size_t samples) noexcept {
    if (writableAudioFrames() < samples) return false;
    auto write = audioWrite_.load(std::memory_order_relaxed);
    for (std::size_t index = 0; index < samples; ++index) {
        audioRing_[write] = {left[index], right[index]};
        write = (write + 1) % audioRing_.size();
    }
    audioWrite_.store(write, std::memory_order_release);
    return true;
}

std::size_t RealtimeDecoderWorker::popAudio(float* left, float* right, std::size_t samples) noexcept {
    const auto available = std::min(samples, readableAudioFrames());
    auto read = audioRead_.load(std::memory_order_relaxed);
    for (std::size_t index = 0; index < available; ++index) {
        left[index] = audioRing_[read].left;
        right[index] = audioRing_[read].right;
        read = (read + 1) % audioRing_.size();
    }
    audioRead_.store(read, std::memory_order_release);
    return available;
}

void RealtimeDecoderWorker::workerLoop() noexcept {
    if (!kernel_->prepare(sampleRate_, blockSize_, voiceCount_)) {
        state_.store(State::kernelError, std::memory_order_release);
        shouldRun_.store(false, std::memory_order_release);
        return;
    }

    ControlPacket latest;
    state_.store(State::running, std::memory_order_release);
    while (shouldRun_.load(std::memory_order_acquire)) {
        ControlPacket incoming;
        while (popControl(incoming)) latest = incoming;

        if (latest.count == 0 || writableAudioFrames() < blockSize_) {
            std::this_thread::sleep_for(std::chrono::microseconds(500));
            continue;
        }

        if (!kernel_->decode(std::span<const ControlFrame>(latest.frames.data(), latest.count),
                             workLeft_.data(), workRight_.data(), blockSize_)) {
            std::fill(workLeft_.begin(), workLeft_.end(), 0.0f);
            std::fill(workRight_.begin(), workRight_.end(), 0.0f);
            state_.store(State::kernelError, std::memory_order_release);
            shouldRun_.store(false, std::memory_order_release);
            break;
        }
        if (!pushAudioBlock(workLeft_.data(), workRight_.data(), blockSize_))
            audioOverruns_.fetch_add(1, std::memory_order_relaxed);
        else
            decodedBlocks_.fetch_add(1, std::memory_order_relaxed);
    }
}

} // namespace lcs
