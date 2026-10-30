"""Reject every dependency conflict except the explicit, tested native override."""
import importlib.metadata
import json
import os
from pathlib import Path
import subprocess
import sys

EXPECTED_CONFLICT = (
    'cognee 1.6.5 has requirement ladybug==0.19.0; sys_platform != "darwin" or '
    '("Darwin Kernel Version 22." not in platform_version and '
    '"Darwin Kernel Version 23." not in platform_version), but you have ladybug 0.22.1.'
)


def validate_check(returncode, stdout, stderr):
    lines = [line.strip() for line in stdout.splitlines() if line.strip()]
    if returncode != 1 or lines != [EXPECTED_CONFLICT] or stderr.strip():
        raise RuntimeError('native_dependency_check_failed')


def main():
    expected = {'cognee': '1.6.5', 'ladybug': '0.22.1', 'pip': '24.0'}
    if any(importlib.metadata.version(name) != version for name, version in expected.items()):
        raise RuntimeError('native_dependency_version')
    prefix = Path(sys.prefix).resolve()
    if sys.prefix == sys.base_prefix:
        raise RuntimeError('native_environment_required')
    import ladybug
    from ladybug._backend import get_pybind_module
    native = get_pybind_module()
    paths = [Path(ladybug.__file__).resolve(), Path(native.__file__).resolve()] if native else []
    if len(paths) != 2 or not all(path.is_relative_to(prefix) for path in paths):
        raise RuntimeError('native_dependency_path')
    environment = {key: value for key, value in os.environ.items() if not key.startswith('PIP_')}
    environment.update(PIP_CONFIG_FILE=os.devnull, PIP_DISABLE_PIP_VERSION_CHECK='1')
    result = subprocess.run([sys.executable, '-I', '-m', 'pip', 'check'], env=environment,
                            capture_output=True, text=True, check=False)
    validate_check(result.returncode, result.stdout, result.stderr)
    print(json.dumps({'state': 'native_environment_verified', 'versions': expected,
                      'singleDeclaredOverride': True, 'nativeModuleWithinEnvironment': True}))


if __name__ == '__main__':
    main()
