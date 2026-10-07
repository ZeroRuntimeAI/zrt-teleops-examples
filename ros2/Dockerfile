# The ros2/ example in one image: ROS 2 Jazzy, the SO-101 driver, the SDK and
# the built bringup package. compose.yaml runs it; README.md has the steps.
FROM ros:jazzy-ros-base

# The README's apt line; the base image already has colcon.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ros-jazzy-ros2-control ros-jazzy-ros2-controllers \
        ros-jazzy-controller-manager ros-jazzy-feetech-ros2-driver \
        ros-jazzy-xacro ros-jazzy-robot-state-publisher python3-venv \
    && rm -rf /var/lib/apt/lists/*

# --system-site-packages: rclpy comes from apt, not PyPI.
ARG SDK="zeroruntime-teleops[ros2]"
RUN python3 -m venv --system-site-packages /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir "$SDK"
ENV PATH=/opt/venv/bin:$PATH

# The working directory is where recordings land: /ws/sessions.
WORKDIR /ws
COPY bringup bringup
RUN . /opt/ros/jazzy/setup.sh && colcon build
COPY env.sh .
# `docker compose exec <role> bash` gets the env.sh shortcuts.
RUN echo 'source /ws/env.sh; source /ws/install/setup.bash' >> /root/.bashrc

ENTRYPOINT ["bash", "-c", "source /opt/ros/jazzy/setup.bash && source /ws/install/setup.bash && exec \"$@\"", "--"]
CMD ["bash"]
