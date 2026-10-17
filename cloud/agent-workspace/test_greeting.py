import unittest
from greeting import greet

class TestGreet(unittest.TestCase):
    def test_normal_name(self):
        self.assertEqual(greet('Ada'), 'Hello, Ada!')

    def test_trimmed_name(self):
        self.assertEqual(greet('  Ada  '), 'Hello, Ada!')

    def test_blank_name(self):
        with self.assertRaises(ValueError):
            greet('')

if __name__ == '__main__':
    unittest.main()