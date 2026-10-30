"""Create an inactive candidate. Never reuse or switch the running environment."""
import os
from pathlib import Path
import platform
import subprocess
import sys


def main():
    if len(sys.argv) != 2 or sys.version_info[:2] != (3, 12) or platform.system() != 'Linux' or platform.machine() != 'x86_64':
        raise RuntimeError('native_installer_requires_linux_x86_64_python312_and_new_destination')
    destination = Path(sys.argv[1])
    if not destination.is_absolute() or os.path.lexists(destination):
        raise RuntimeError('native_destination_must_be_new_and_absolute')
    destination.parent.resolve(strict=True)
    # Atomic claim: a concurrent/pre-existing destination is never cleared.
    destination.mkdir(mode=0o700)
    root = Path(__file__).resolve().parent
    environment = {key: value for key, value in os.environ.items()
                   if not key.startswith('PIP_') and key not in {'PYTHONPATH', 'PYTHONHOME', 'PYTHONUSERBASE', 'VIRTUAL_ENV'}}
    environment.update(PIP_CONFIG_FILE=os.devnull, PIP_DISABLE_PIP_VERSION_CHECK='1')
    subprocess.run([sys.executable, '-I', '-m', 'venv', str(destination)], env=environment, check=True)
    python = str(destination / 'bin/python')

    def install(lock, *options):
        subprocess.run([python, '-I', '-m', 'pip', 'install', '--no-input', '--require-hashes',
                        *options, '-r', str(root / lock)], env=environment, check=True)

    install('native-tools.lock')
    install('build.lock')
    install('requirements.lock', '--no-build-isolation')
    # The full original dependency lock is installed first. Only this one
    # application-tested override may diverge; the checker rejects all others.
    install('native-overrides.lock', '--no-deps', '--only-binary=:all:')
    subprocess.run([python, '-I', str(root / 'check_native_environment.py')], env=environment, check=True)
    # Public package code can now be executed by the unprivileged service user.
    destination.chmod(0o755)


if __name__ == '__main__':
    main()
