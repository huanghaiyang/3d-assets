cmake_minimum_required(VERSION 3.22)
project(kimodo-shim LANGUAGES CXX)

# kimodo.cpp 源码根目录（外部引用，不复制文件）
set(KIMODO_SRC "D:/thirdparty/kimodo.cpp")
set(KIMODO_BUILD "D:/thirdparty/kimodo.cpp/build-win")

add_executable(kmd-conditioned-server main.cpp)

target_include_directories(kmd-conditioned-server PRIVATE
  "${KIMODO_SRC}/include"
  "${KIMODO_SRC}/src"
  "${KIMODO_BUILD}"          # ggml-generated build config
)

# kimodo.lib 包含 denoiser / skeleton / motion_decode / ggml_weights 等全部实现
target_link_libraries(kmd-conditioned-server PRIVATE
  "${KIMODO_BUILD}/Release/kimodo.lib"
  "${KIMODO_BUILD}/ggml/src/Release/ggml.lib"
  "${KIMODO_BUILD}/ggml/src/Release/ggml-base.lib"
  "${KIMODO_BUILD}/ggml/src/Release/ggml-cpu.lib"
)

target_compile_features(kmd-conditioned-server PRIVATE cxx_std_20)
if (MSVC)
  target_compile_options(kmd-conditioned-server PRIVATE /W3 /EHsc /permissive- /std:c++latest /utf-8)
  target_compile_definitions(kmd-conditioned-server PRIVATE NOMINMAX WIN32_LEAN_AND_MEAN)
endif()

# 安装/拷贝：把可执行文件和必须的 DLL 拷到一个目录
add_custom_command(TARGET kmd-conditioned-server POST_BUILD
  COMMAND ${CMAKE_COMMAND} -E make_directory "$<TARGET_FILE_DIR:kmd-conditioned-server>"
  COMMAND ${CMAKE_COMMAND} -E copy
    "${KIMODO_BUILD}/bin/Release/ggml.dll"
    "${KIMODO_BUILD}/bin/Release/ggml-base.dll"
    "${KIMODO_BUILD}/bin/Release/ggml-cpu.dll"
    "$<TARGET_FILE_DIR:kmd-conditioned-server>/"
  COMMENT "复制 ggml 运行时 DLL"
)
