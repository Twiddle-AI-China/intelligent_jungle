#pragma once

#include "WorldTypes.h"
#include <span>

namespace lcs {

class DecoderBackend {
public:
    virtual ~DecoderBackend() = default;
    virtual bool initialise(double sampleRate, std::size_t maximumBlockSize, std::size_t voices) = 0;
    virtual void submit(std::span<const ControlFrame> frames) noexcept = 0;
    virtual bool render(float* left, float* right, std::size_t samples) noexcept = 0;
    virtual const char* status() const noexcept = 0;
};

class SilentDecoder final : public DecoderBackend {
public:
    bool initialise(double, std::size_t, std::size_t) override { return false; }
    void submit(std::span<const ControlFrame>) noexcept override {}
    bool render(float*, float*, std::size_t) noexcept override { return false; }
    const char* status() const noexcept override { return "DECODER OFFLINE -- SILENCE IS INTENTIONAL"; }
};

} // namespace lcs
