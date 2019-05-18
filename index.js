const TeamSpeak3 = require("ts3-nodejs-library")
const EventEmitter = require("events")
const fs = require("fs");
const config = require("./config.json");

class TS3Base extends EventEmitter {
  constructor(config) {
    super();
    this.ready = false;
    this.config = config;
    this.ts3 = new TeamSpeak3(config);
    this.ts3.on("error", e => console.log("Error", e.message));
    this.ts3.on("close", e => console.log("Connection has been closed!", e));
    this.ts3.on("ready", () => { this.ready = true; this.emit("ready"); });
  }
}

class TS3Reader extends TS3Base {
  constructor(config) {
    super(config);
  }

  async readServerGroups() {
    try {
      const serverGroups = await this.ts3.serverGroupList()
      return Promise.all(serverGroups.map(async sg => {
        const sgid = sg.getSGID();
        let perms = {};
        try {
          perms = await sg.permList();
        } catch(e) {
          console.log("Error while resolving permissions for role ", sg.name, e.message);
        }
        return {id: sgid, name: sg.name, type: sg.type, permissions: perms};
      }));
    } catch (e) {
      console.log("Caught an error!");
      console.error(e)
    }
  }

  async readChannelGroups() {
    try {
      const channelGroups = await this.ts3.serverGroupList()
      return Promise.all(channelGroups.map(async sg => {
        const sgid = sg.getSGID();
        let perms = {};
        try {
          perms = await sg.permList();
        } catch(e) {
          console.log("Error while resolving permissions for role ", sg.name, e.message);
        }
        return {id: sgid, name: sg.name, type: sg.type, permissions: perms};
      }));
    } catch (e) {
      console.log("Caught an error!");
      console.error(e)
    }
  }

  async readChannels() {
    try {
      const channels = await this.ts3.channelList();
      return Promise.all(channels.map(async c => {
        const cid = c.getID();
        const cinfo = await c.getInfo();
        const cperms = await c.permList(true);
        try {
          cicon = await c.getIconName(); 
        } catch(e) {}
        return {id: cid, info: cinfo, permissions: cperms};
      }));
    } catch (e) {
      console.log("Caught an error!");
      console.error(e)
    }
  }
}

let logerr = (err) => {
  if(err) {
    return console.log(err);
  }  
};

let tsr = new TS3Reader(config);
tsr.on("ready", () => {
  console.log("Ready");
  console.log("Reading Server Groups")
  tsr.readServerGroups().then(gs => fs.writeFile("./sgroups.json", JSON.stringify(gs), logerr));
  tsr.readChannels().then(cs => fs.writeFile("./chans.json", JSON.stringify(cs), logerr));
  tsr.readChannelGroups().then(gs => fs.writeFile("./cgroups.json", JSON.stringify(gs), logerr));
});