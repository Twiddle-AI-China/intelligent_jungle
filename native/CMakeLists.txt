cmake_minimum_required(VERSION 3.24)
project(LatentCosmosSynth VERSION 0.1.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

option(LCS_BUILD_APP "Build the JUCE macOS standalone application" OFF)
find_package(Threads REQUIRED)

add_library(lcs_core
    src/RealtimeDecoderWorker.cpp
    src/WorldEngine.cpp
)
target_include_directories(lcs_core PUBLIC include)
target_link_libraries(lcs_core PUBLIC Threads::Threads)
target_compile_options(lcs_core PRIVATE -Wall -Wextra -Wpedantic)

enable_testing()
add_executable(lcs_core_tests tests/WorldEngineTests.cpp)
target_link_libraries(lcs_core_tests PRIVATE lcs_core)
add_test(NAME lcs_core_tests COMMAND lcs_core_tests)
add_executable(lcs_decoder_worker_tests tests/RealtimeDecoderWorkerTests.cpp)
target_link_libraries(lcs_decoder_worker_tests PRIVATE lcs_core)
add_test(NAME lcs_decoder_worker_tests COMMAND lcs_decoder_worker_tests)

if(LCS_BUILD_APP)
    include(FetchContent)
    FetchContent_Declare(JUCE
        GIT_REPOSITORY https://github.com/juce-framework/JUCE.git
        GIT_TAG 8.0.13
        GIT_SHALLOW TRUE
    )
    FetchContent_MakeAvailable(JUCE)

    juce_add_gui_app(LatentCosmos
        PRODUCT_NAME "Latent Cosmos Synth"
        COMPANY_NAME "Twiddle"
        BUNDLE_ID "com.twiddle.latent-cosmos"
        MICROPHONE_PERMISSION_ENABLED FALSE
    )
    juce_generate_juce_header(LatentCosmos)
    target_sources(LatentCosmos PRIVATE app/Main.cpp)
    target_link_libraries(LatentCosmos PRIVATE
        lcs_core
        juce::juce_audio_utils
        juce::juce_dsp
        juce::juce_gui_extra
    )
    target_compile_definitions(LatentCosmos PRIVATE
        JUCE_WEB_BROWSER=0
        JUCE_USE_CURL=0
    )
endif()
