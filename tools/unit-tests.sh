#!/bin/sh
# SPDX-License-Identifier: MIT
# Unit tests of the core. Cross-platform launcher: tools/unit_tests.py.
exec python3 -I "$(dirname "$0")/unit_tests.py"
