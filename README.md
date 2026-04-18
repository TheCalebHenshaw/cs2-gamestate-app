# cs2-gamestate-app

## Application Goals / Overview
This will be a cs2 utility application that uses the GSI capabilities in cs2 to send post requests to a local server on the users machine. Using this information we can enhance users with a second monitor to benefit from seeing smoke lineups, flashes, molotovs depending on what team and map they're on. 

We want to allow the user (who will be in fullscreen mode for cs2) to provide more detailed information such as what bomb site they would like to go to, where our API will send information such as smoke lineups for A Site Mirage.

## Application Hard Requirements
1. Application cannot reduce the FPS of the player by more than 15 FPS
2. Must adhere  to the Valve TOS
3. Assume that players have a second monitor, or that they can use the app with Shift+Tab Steam Web Browser whilst in-game

### Architecture

CS2 will send POST requests to port 3000 on the client machine
Client machine should be able to make a POST with certain data and return information from the APP Server which will be on the cloud



CS2 --> Local Application <--> Cloud Hosted API


**Local Application**
This should be some sort of ElectronJs application that can receive the data from CS2 and also make API requests to the external API/Server. 
- Use React or Angular to display things such as smoke lineups and retrieve the data from the external API/Server. 
- Store things in memory such as Current map, player steam ID and other data coming from the CS2 Gamestate integration data.
- Have logic on what to display and how to display it, just receive information etc from Cloud Server
- Smart memory usage, should be able to disregard extra information given from CS2 GSI POST requests and make use of new information accordingly (player has gone from in a game to main menu, change to main menu view)


Local Application should expect inputs from both the user and CS2
CS2 will provide information such as
- Map
- Phase (live, menu)
- Round (round wins)
- Current Team
- Player information (steamid, name, kills, armor, health, equip_value, match_stats)


User optionally can provide this further information using a preconfigured Global AutoHotkey (which will send POST requests to the local application)
- Position they intend to go (for example Mid, A Site, B Site)
- Utility they'd like to see displayed (Flashes, Smokes, Molotovs, HE Grenade)

After the user gives some input, they will expect some information given back. This is where we will make a GET request to the Cloud API which will return data such as common lineups for A Site, including Images and Gifs of how to throw the utility. 



**Application / Server in the Cloud**
This will have a database that will store blobs, update the database with new lineups etc
API's should accept GET requests
- Should we actually store videos as blob storage (this can be expensive), alternatively why don't we just find youtube videos and use the youtube embed player and just store the URLs
- What would maintenance look like for updating youtube videos etc if we take this option
- What else should be in this?



## Finishing the Application
Can we package the entire thing as an exe?


## General Notes
- Authentication to the cloud server by using tokens?
- Restrict what the user can see development wise
- Ensure it's all VAC safe
- Global HotKey management to ensure that the user does not need to TAB out of the fullscreen CS2 game
- Allow for the users to customize their Hotkeys
- Optimization - how can we cache images?