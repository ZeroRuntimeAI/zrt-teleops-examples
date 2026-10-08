cmake_minimum_required(VERSION 3.16)
project(so101_teleop_bringup LANGUAGES NONE)

find_package(ament_cmake REQUIRED)

# Nothing to compile; the launch files find config/ and urdf/ beside them.
install(DIRECTORY launch config urdf DESTINATION share/${PROJECT_NAME})

ament_package()
