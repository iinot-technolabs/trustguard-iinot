#!/bin/bash
# Colour-coded logging helpers used across all network scripts

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Colour

function infoln() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

function warnln() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

function errorln() {
    echo -e "${RED}[ERROR]${NC} $1"
}

function successln() {
    echo -e "${BLUE}[SUCCESS]${NC} $1"
}
