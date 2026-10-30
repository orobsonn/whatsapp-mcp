import unittest
from check_native_environment import EXPECTED_CONFLICT, validate_check


class NativeDependencyOverride(unittest.TestCase):
    def test_accepts_only_the_declared_single_conflict(self):
        validate_check(1, EXPECTED_CONFLICT + '\n', '')

    def test_rejects_other_conflicts_missing_packages_and_tool_failures(self):
        for status, stdout, stderr in [
            (1, EXPECTED_CONFLICT + '\nexample requires missing-package\n', ''),
            (1, 'unrelated-package has an incompatible requirement', ''),
            (0, 'No broken requirements found.', ''),
            (2, EXPECTED_CONFLICT, ''),
            (1, EXPECTED_CONFLICT, 'checker execution failed'),
        ]:
            with self.subTest(status=status, stdout=stdout, stderr=stderr):
                with self.assertRaisesRegex(RuntimeError, 'native_dependency_check_failed'):
                    validate_check(status, stdout, stderr)


if __name__ == '__main__':
    unittest.main()
