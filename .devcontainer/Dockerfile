# syntax=docker/dockerfile:1

FROM ghcr.io/exergy-connect/xframe.ai:latest

USER root

# Native tools used when rebuilding the committed WebAssembly artifacts.
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install --no-install-recommends -y \
        build-essential \
        cmake \
        ninja-build \
        pkg-config \
        python3 \
        python3-pip \
    && rm -rf /var/lib/apt/lists/*

USER vscode
