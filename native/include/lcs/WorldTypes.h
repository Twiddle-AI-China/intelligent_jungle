#pragma once

#include <array>
#include <cstdint>
#include <string>
#include <vector>

namespace lcs {

constexpr std::size_t perceptualDimensions = 6;
constexpr double fixedTimeStep = 1.0 / 200.0;

enum class Role { bass, support, ornament };
enum class ForceMode { none, gather, scatter, guide, disturb, energize };

struct UserForce {
    ForceMode mode{ForceMode::none};
    float x{0.5f};
    float y{0.5f};
    float dx{};
    float dy{};
    float strength{};
};

struct NicheState {
    float holdSeconds{};
    float cooldownSeconds{};
    float conflictSeconds{};
    std::uint32_t decisions{};
    std::string action;
};

struct SoundObjectState {
    std::uint32_t id{};
    Role role{Role::support};
    std::array<float, perceptualDimensions> identityAnchor{};
    std::array<float, perceptualDimensions> perceptualPosition{};
    std::array<float, perceptualDimensions> perceptualVelocity{};
    float rhythmPhase{};
    float naturalRate{1.0f};
    float energy{0.48f};
    float energyVelocity{};
    int pitchClass{};
    int pitchRegister{};
    float pan{};
    float panAnchor{};
    float panVelocity{};
    float pulse{};
    NicheState niche;
};

struct WorldTelemetry {
    float phaseCoherence{};
    float trendAgreement{};
    float collectiveSpeed{};
    bool trendActive{};
    float maskingCost{};
    float identityDrift{};
    float identitySpread{};
    float decisionRate{};
};

struct WorldState {
    std::uint32_t seed{};
    double time{};
    double accumulator{};
    float tempo{82.0f};
    int harmonicCenter{};
    std::array<float, 12> harmonicField{};
    float temperature{};
    std::uint64_t lastBar{};
    UserForce force;
    std::vector<SoundObjectState> objects;
    WorldTelemetry telemetry;
};

struct ControlFrame {
    std::uint32_t objectId{};
    std::array<float, perceptualDimensions> perceptual{};
    float phase{};
    float energy{};
    int pitchClass{};
    int pitchRegister{};
    float pan{};
};

} // namespace lcs
