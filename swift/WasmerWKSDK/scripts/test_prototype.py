import unittest

from prototype import select_simulator


class SimulatorSelectionTests(unittest.TestCase):
    def setUp(self):
        self.devices = {"devices": {
            "com.apple.CoreSimulator.SimRuntime.iOS-26-5": [
                {"udid": "old", "state": "Booted"},
            ],
            "com.apple.CoreSimulator.SimRuntime.iOS-27-0": [
                {"udid": "new", "state": "Shutdown"},
                {"udid": "unavailable", "state": "Booted", "isAvailable": False},
            ],
        }}

    def test_does_not_choose_booted_ios26(self):
        self.assertEqual(select_simulator(self.devices)["udid"], "new")

    def test_explicit_incompatible_device_is_rejected(self):
        with self.assertRaisesRegex(SystemExit, "iOS 27"):
            select_simulator(self.devices, "old")

    def test_no_supported_runtime_is_actionable(self):
        with self.assertRaisesRegex(SystemExit, "iOS 27"):
            select_simulator({"devices": {}})


if __name__ == "__main__":
    unittest.main()
