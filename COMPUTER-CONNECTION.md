# Use Tally on your computer

Your phone keeps your book. The computer is a bigger screen for that same book.

## Connect in five steps

1. Put your phone and computer on the same Wi-Fi. You can also turn on your phone's hotspot and connect the computer to it.
2. On your phone, open **Tally → Settings → Use Tally on your computer → Start connection**. Keep Tally open.
3. On your computer, open the website address shown on the phone, using a current Chrome or Edge browser. You do not install anything on the computer.
4. Type the **phone address** and **joining code** from the phone into the computer page. Tap **Connect**. If the browser asks to find devices on your network, choose **Allow**.
5. Both screens show another set of numbers. Check that they match. Tap **Yes, they match** on both devices. If they differ, disconnect and start again.

The joining code lets the computer ask to connect. The matching numbers let you check that you are approving the right phone and computer. No expense information is shown before both approvals.

## Make changes

You can use both screens while connected. Add, edit or delete ordinary income and expense entries on the computer. Choose **Save on phone** and wait for **Saved on your phone**. The phone saves the change; the computer does not keep another book.

Phone changes appear on the computer, usually within a second. If you edit the same entry on both devices, the computer asks you to **Refresh entry** before it can save. Read the latest entry before making your change again. It will not silently replace the newer phone edit.

This first version shows personal RM account balances and the latest 200 entries in those accounts. Receipt and split-bill entries can be viewed as entry summaries; edit their details on the phone. Receipt photos and item lists are not sent to the computer. Transfers are view-only. Joint, business and foreign-currency accounts are not available in this editor.

## Finish or reconnect

Tap **Disconnect** on either device when you finish. Locking the phone or switching away from Tally also ends the connection. When the computer detects a lost connection, it clears the expense screen and asks you to connect again. A sudden Wi-Fi loss can take several seconds to detect.

Saved changes stay on the phone. Unsaved typing is cleared: save before disconnecting. If the connection drops while saving, check the phone before trying again—the save might already have completed.

The phone remembers the entry you were editing and your list position. After fresh pairing, the computer reopens the latest saved entry where possible. An unsaved form is not restored.

## If it does not connect

- Check both devices use the same Wi-Fi. Guest Wi-Fi can prevent them from connecting; try your phone hotspot.
- Keep Tally open and the phone unlocked. Tap **Disconnect**, then **Start connection** for a new code if the old one expired.
- Use a current Chrome or Edge browser. Check its local-network permission if you previously chose Block.
- The temporary phone address can change each time. Type the new address and code exactly as shown.

## What stays private

The connection is optional and off until you start it. Pairing uses a temporary local phone endpoint; it carries connection details, not expense records. Approved book data travels over an encrypted WebRTC data channel between your devices. There is no Tally cloud database or external relay for this feature.

The computer keeps book data in temporary page memory, without saving it to a browser database or browser storage. Disconnect clears that page data. This cannot prevent someone you approve from taking a screenshot or copying what they see. Use your own trusted computer.

## Development status

The editor is implemented locally. The public computer URL must be deployed before ordinary users can connect with it. Nothing in this document authorizes publishing. Android device and browser verification results are recorded in `D:/tally-android/verification/`; rerun checks after relevant changes.
