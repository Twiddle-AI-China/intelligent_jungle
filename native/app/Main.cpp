#include <JuceHeader.h>
#include "lcs/DecoderBackend.h"
#include "lcs/WorldEngine.h"
#include <algorithm>
#include <array>
#include <atomic>

class MainComponent final : public juce::AudioAppComponent,
                            private juce::Timer,
                            private juce::MidiInputCallback {
public:
    MainComponent() {
        setOpaque(true);
        setWantsKeyboardFocus(true);
        setSize(1100, 720);
        setAudioChannels(0, 2);
        for (const auto& device : juce::MidiInput::getAvailableDevices()) {
            if (auto input = juce::MidiInput::openDevice(device.identifier, this)) {
                input->start();
                midiInputs.push_back(std::move(input));
            }
        }
        startTimerHz(60);
    }

    ~MainComponent() override { shutdownAudio(); }

    void prepareToPlay(int samplesPerBlockExpected, double sampleRate) override {
        decoder.initialise(sampleRate, static_cast<std::size_t>(samplesPerBlockExpected), 6);
    }

    void getNextAudioBlock(const juce::AudioSourceChannelInfo& buffer) override {
        buffer.clearActiveBufferRegion();
        const auto active = activeFrameBuffer.load(std::memory_order_acquire);
        readerFrameBuffer.store(active, std::memory_order_release);
        decoder.submit(std::span<const lcs::ControlFrame>(frameBuffers[active].data(), frameCounts[active]));
        if (buffer.buffer->getNumChannels() >= 2)
            decoder.render(buffer.buffer->getWritePointer(0, buffer.startSample), buffer.buffer->getWritePointer(1, buffer.startSample), static_cast<std::size_t>(buffer.numSamples));
        readerFrameBuffer.store(-1, std::memory_order_release);
    }

    void releaseResources() override {}

    void paint(juce::Graphics& g) override {
        g.fillAll(juce::Colour::fromRGB(5, 11, 10));
        auto area = getLocalBounds().toFloat().reduced(28.0f);
        g.setColour(juce::Colour::fromRGB(169, 239, 207));
        g.setFont(juce::FontOptions(14.0f));
        g.drawText("LATENT COSMOS SYNTH / NATIVE ALPHA", area.removeFromTop(34.0f), juce::Justification::left);
        g.setColour(juce::Colour::fromRGB(120, 139, 131));
        g.drawText(decoder.status(), area.removeFromBottom(30.0f), juce::Justification::left);
        g.setColour(juce::Colour::fromRGB(169, 239, 207));
        g.drawText(juce::String("BEHAVIOR: ") + modeName(), area.removeFromBottom(26.0f), juce::Justification::right);
        const auto worldArea = area.reduced(20.0f);
        for (const auto& object : engine.state().objects) {
            const float x = worldArea.getX() + object.perceptualPosition[0] * worldArea.getWidth();
            const float y = worldArea.getY() + object.perceptualPosition[1] * worldArea.getHeight();
            const float radius = 7.0f + object.energy * 10.0f + object.pulse * 5.0f;
            g.setColour(juce::Colour::fromHSV(0.38f + object.perceptualPosition[0] * 0.16f, 0.55f, 0.85f, 0.22f));
            g.fillEllipse(x - radius * 2, y - radius * 2, radius * 4, radius * 4);
            g.setColour(juce::Colour::fromRGB(217, 255, 240));
            g.fillEllipse(x - 3, y - 3, 6, 6);
        }
    }

    void mouseDown(const juce::MouseEvent& event) override { grabKeyboardFocus(); applyPointer(event, currentMode); }
    void mouseDrag(const juce::MouseEvent& event) override { applyPointer(event, currentMode); }
    void mouseUp(const juce::MouseEvent&) override { engine.release(); }

    bool keyPressed(const juce::KeyPress& key) override {
        if (key == juce::KeyPress('1')) currentMode = lcs::ForceMode::gather;
        else if (key == juce::KeyPress('2')) currentMode = lcs::ForceMode::scatter;
        else if (key == juce::KeyPress('3')) currentMode = lcs::ForceMode::guide;
        else if (key == juce::KeyPress('4')) currentMode = lcs::ForceMode::disturb;
        else if (key == juce::KeyPress('5')) currentMode = lcs::ForceMode::energize;
        else if (key == juce::KeyPress::spaceKey) engine.release();
        else return false;
        repaint();
        return true;
    }

private:
    void timerCallback() override {
        const auto note = pendingMidiNote.exchange(-1, std::memory_order_acq_rel);
        if (note >= 0) engine.noteOn(note, pendingMidiVelocity.load(std::memory_order_acquire));
        engine.advance(1.0 / 60.0);
        const auto active = activeFrameBuffer.load(std::memory_order_acquire);
        const auto reader = readerFrameBuffer.load(std::memory_order_acquire);
        int inactive = 0;
        while (inactive == active || inactive == reader) ++inactive;
        const auto frames = engine.controlFrames();
        frameCounts[inactive] = std::min(frames.size(), frameBuffers[inactive].size());
        std::copy_n(frames.begin(), frameCounts[inactive], frameBuffers[inactive].begin());
        activeFrameBuffer.store(inactive, std::memory_order_release);
        repaint();
    }

    juce::String modeName() const {
        if (currentMode == lcs::ForceMode::gather) return "GATHER / 1";
        if (currentMode == lcs::ForceMode::scatter) return "SCATTER / 2";
        if (currentMode == lcs::ForceMode::guide) return "GUIDE / 3";
        if (currentMode == lcs::ForceMode::disturb) return "DISTURB / 4";
        if (currentMode == lcs::ForceMode::energize) return "ENERGIZE / 5";
        return "RELEASED";
    }

    void applyPointer(const juce::MouseEvent& event, lcs::ForceMode mode) {
        const auto bounds = getLocalBounds().toFloat();
        lcs::UserForce force;
        force.mode = mode;
        force.x = event.position.x / bounds.getWidth();
        force.y = event.position.y / bounds.getHeight();
        force.dx = event.getDistanceFromDragStartX() / bounds.getWidth();
        force.dy = event.getDistanceFromDragStartY() / bounds.getHeight();
        force.strength = 1.0f;
        engine.setForce(force);
    }

    void handleIncomingMidiMessage(juce::MidiInput*, const juce::MidiMessage& message) override {
        if (message.isNoteOn()) {
            pendingMidiVelocity.store(message.getFloatVelocity(), std::memory_order_release);
            pendingMidiNote.store(message.getNoteNumber(), std::memory_order_release);
        }
    }

    lcs::WorldEngine engine;
    lcs::SilentDecoder decoder;
    lcs::ForceMode currentMode{lcs::ForceMode::gather};
    std::array<std::array<lcs::ControlFrame, 12>, 3> frameBuffers{};
    std::array<std::size_t, 3> frameCounts{};
    std::atomic<int> activeFrameBuffer{0};
    std::atomic<int> readerFrameBuffer{-1};
    std::atomic<int> pendingMidiNote{-1};
    std::atomic<float> pendingMidiVelocity{0.0f};
    std::vector<std::unique_ptr<juce::MidiInput>> midiInputs;
};

class LatentCosmosApplication final : public juce::JUCEApplication {
public:
    const juce::String getApplicationName() override { return "Latent Cosmos Synth"; }
    const juce::String getApplicationVersion() override { return "0.1.0"; }
    void initialise(const juce::String&) override { window = std::make_unique<Window>(getApplicationName()); }
    void shutdown() override { window.reset(); }

private:
    class Window final : public juce::DocumentWindow {
    public:
        explicit Window(const juce::String& name) : DocumentWindow(name, juce::Colour::fromRGB(5, 11, 10), allButtons) {
            setUsingNativeTitleBar(true);
            setContentOwned(new MainComponent(), true);
            centreWithSize(getWidth(), getHeight());
            setVisible(true);
        }
        void closeButtonPressed() override { juce::JUCEApplication::getInstance()->systemRequestedQuit(); }
    };
    std::unique_ptr<Window> window;
};

START_JUCE_APPLICATION(LatentCosmosApplication)
