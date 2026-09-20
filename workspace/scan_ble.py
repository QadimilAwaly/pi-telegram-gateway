import asyncio
from bleak import BleakScanner

async def scan():
    print("Scanning BLE devices for 8 seconds...")
    devices = await BleakScanner.discover(timeout=8.0, return_adv=True)
    found = []
    for address, (device, adv) in devices.items():
        name = device.name or adv.local_name or "Unknown"
        rssi = adv.rssi
        uuids = adv.service_uuids or []
        found.append((address, name, rssi, uuids))
    
    # Sort by signal strength (RSSI)
    found.sort(key=lambda x: x[2], reverse=True)
    
    print(f"\nFound {len(found)} BLE devices:")
    print("-" * 75)
    print(f"{'Address / MAC':<20} | {'RSSI':<6} | {'Name':<25} | {'Services'}")
    print("-" * 75)
    for addr, name, rssi, uuids in found:
        uuid_str = ", ".join(uuids[:2]) if uuids else "-"
        print(f"{addr:<20} | {rssi:<6} | {name:<25} | {uuid_str}")

if __name__ == "__main__":
    asyncio.run(scan())
