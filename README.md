# xap-hub
An enhanced, cross-platform hub for xAP built for NodeJS.

# Install and run
* Compiled code and dependencies can be installed from npmjs: ``npm install xap-hub``
* Run from the command line: ``node ./lib/xap-hub.js [-v]``
* Stops on receiving SIGINT, ctrl-C.

## Enhanced client interaction
The traditional client to hub setup process has been:
1. Client binds to a localhost socket and is allocated an available port number by the OS
2. Client sends a heartbeat message containing the port number to the xAP broadcast address 
3. Hub receives hearbeat message, determines that it came from the same xAP broadcast address that it is using and adds it to its client list
4. Hub begins forwarding messages received on the main xAP port (3639) to the client on its local port.

This works well but has the disadvantage that each client must determine the xAP broadcast address for transmission.  
Each client transmits directly to the xAP broadcast address while receiving xAP messages via the hub.

This enhanced hub eliminates the need for a client to determine the xAP broadcast address by taking on responsibility
for forwarding xAP messages in both directions between the network and its clients.

The revised client to hub setup process is:
1. Client binds to a localhost socket and is allocated an available port number by the OS
2. Client sends a heartbeat message containing the port number to localhost port 3639
3. Hub receives hearbeat message on localhost and adds it to its client list
4. Hub begins forwarding messages received on the main xAP port (3639) to the client on its local port
5. Hub begins forwarding messages received on localhost to the xAP broadcast address.

Simplified client applications using the enhanced hub need only communicate with localhost.  
Unmodified clients continue to work as before but simplified clients require the enhanced hub.  
Applications written using the xap-framework for NodeJS assume enhanced hub communication by default.

## Logging
xap-hub with no options runs silently. Specifying the -v\[1\], -v2 or -v3 flag produces increasingly verbose logging to stdout.
* Level 1: socket setup, client connect, disconnect, inactive
* Level 2: client refresh
* Level 3: network message received, client message received

## Dependencies
xap-hub uses:
* xap-net-address to determine local network and broadcast addresses
* xap-framework for heartbeat header parsing.


