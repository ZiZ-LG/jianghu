#!/usr/bin/env python3
"""Stream the unchanged PostgreSQL regression, with honest progress timestamps."""
import os
import re
import selectors
import signal
import subprocess
import sys
import time


def run(command, interval=60, output=None):
    output = output or sys.stdout.buffer
    child = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                             start_new_session=True)
    previous = {}

    def forward(sig, _frame):
        try:
            os.killpg(child.pid, sig)
        except ProcessLookupError:
            pass

    for sig in [signal.SIGTERM, signal.SIGINT]:
        previous[sig] = signal.signal(sig, forward)
    start = last_output = time.monotonic()
    next_beat = start + interval
    checkpoint = 'none'
    tail = b''
    selector = selectors.DefaultSelector()
    selector.register(child.stdout, selectors.EVENT_READ)
    try:
        while selector.get_map():
            for key, _ in selector.select(max(0, next_beat - time.monotonic())):
                data = os.read(key.fd, 65536)
                if not data:
                    selector.unregister(key.fileobj)
                    continue
                output.write(data)
                output.flush()
                last_output = time.monotonic()
                tail = (tail + data)[-8192:]
                markers = re.findall(rb'(?m)^([A-Z][A-Z0-9_]*_OK)=1\r?$', tail)
                if markers:
                    checkpoint = markers[-1].decode('ascii')
            now = time.monotonic()
            if now >= next_beat and child.poll() is None:
                output.write(('\n[postgres-ops heartbeat] elapsed={:.0f}s '
                              'last_output_age={:.0f}s last_checkpoint={} '
                              'process_alive=true; heartbeat is not proof of test progress\n'
                              .format(now - start, now - last_output, checkpoint)).encode())
                output.flush()
                next_beat = now + interval
        result = child.wait()
        output.write(('\n[postgres-ops finished] elapsed={:.1f}s exit={}\n'
                      .format(time.monotonic() - start, result)).encode())
        output.flush()
        return result if result >= 0 else 128 - result
    finally:
        selector.close()
        child.stdout.close()
        for sig, handler in previous.items():
            signal.signal(sig, handler)
        if child.poll() is None:
            os.killpg(child.pid, signal.SIGTERM)
            try:
                child.wait(timeout=15)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait()


if __name__ == '__main__':
    sys.exit(run(['bash', 'scripts/test-postgres-ops-integration.sh']))
