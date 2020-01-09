const TeamSpeak3 = require("ts3-nodejs-library")
const EventEmitter = require("events")
const fs = require("fs");
const config = require("./config.json");
const stable = require("stable");

const CHANS_FILE = "./chans.json";
const SGROUPS_FILE = "./sgroups.json";
const CGROUPS_FILE = "./cgroups.json";

const BREATHER_AFTER = 15; // even with flooding disabled, some servers (rented ones...) will kick the bot if too many commands are coming in...
const BREATHER_SLEEP = 10000;  // ...this gives a little breather of this many ms after BREATHER commands
const MAX_RUNTIME = 1000000; // bot will automatically logout after this time to avoid stale connections

function filterDictionary(dict, allowed) {
  Object.keys(dict).forEach(k => {
    if(!allowed.includes(k)) {
      delete dict[k];
    }
  });
  return dict;
}

async function wait(ms) {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

class TS3Base extends EventEmitter {
  constructor(config) {
    super();
    this.ready = false;
    this.config = config;
    this.connect();
    this.commandCount = 0;
  }

  connect() {
    this.ts3 = new TeamSpeak3(this.config);
    this.ts3.on("error", e => console.log("Error", e.message));
    this.ts3.on("close", e => console.log("Connection has been closed!", e));
    this.ts3.on("ready", () => { 
      this.ready = true; 
      this.emit("ready"); 
    });    
  }

  async breath() {
    this.commandCount = (this.commandCount+1) % BREATHER_AFTER;
    if(this.commandCount == 0) {
      await wait(BREATHER_SLEEP);
    }
  }

  async reconnect() {
    if(this.ts3) {
      this.ts3.logout();
    }
    this.connect();
  }

  async init() {
    // can't have await in constructor
    await this.ts3.useBySid(this.config.serverid, this.config.nickname)
    .catch((e) => console.log("useBySid", e));
  }

  logout() {
    this.ts3.logout();
  }
}

class TS3Writer extends TS3Base {
  constructor(config) {
    super(config);
  }

  async writeServerGroups(json) {
    for(const g of json) {
      //if(g.name === "Server Admin") continue;
      let group = await this.ts3.getServerGroupByName(g.name).catch((e) => console.log("getServerGroupByName", e));
      if(!group) {
        group = await this.ts3.serverGroupCreate(g.name, g.type).catch((e) => console.log("serverGroupCreate", e));
      }
      if(Array.isArray(g.permissions)) { // I failed at the write part, so empty permissions are now an empty dictionary {}
        for(const p of g.permissions) {
          await this.ts3.serverGroupAddPerm(group.sgid, p.permid, p.permvalue, p.permskip, p.permnegated).catch((e) => console.log("serverGroupAddPerm", e, group, p));
        }        
      }
      this.breath();
    }    
  }

  async writeChannelGroups(json) {
    for(const g of json) {
      //if(g.name === "Server Admin") continue;
      if(g.type == 2) continue; // skip server query groups

      let group = await this.ts3.getChannelGroupByName(g.name).catch((e) => console.log("getChannelGroupByName", e));

      if(!group) {
        group = await this.ts3.channelGroupCreate(g.name, g.type).catch((e) => console.log("channelGroupCreate", e));
      }
      if(Array.isArray(g.permissions)) { // I failed at the write part, so empty permissions are now an empty dictionary {}
        for(const p of g.permissions) {
          try {
            await this.ts3.channelGroupAddPerm(group.cgid, p.permid, p.permvalue, p.permskip, p.permnegated).catch((e) => console.log("channelGroupAddPerm", e, group, p));
          } catch(ex) {
            console.log("Error: ", ex.message);
          }
        }        
      }
      this.breath();
    } 
  }

  async writeChannels(json) {
    // TS creates hierachy by having the channel ID of the parent in channel_order.
    // Those IDs have faithfully been copied from the source server, but could differ on the destination server.
    // So whenever we create a new channel, we need to map their old ID onto their new assigned ID.
    // That enables child channels to look up the proper ID of the parent they are to supposed to sit under.
    // By ordering channels by their old ID we can ensure having channels created in proper order.
    const cids = {0:0};
    const names = {0:"root"};
    stable.inplace(json, (x,y) => y.id - x.id);
    stable.inplace(json, (x,y) => x.info.pid - y.info.pid); // order by cid to create top channels first

    // create channels
    for(const c of json) {
      try {
        const chan = await this.ts3.getChannelByName(c.info.channel_name).catch((e) => console.log("getChannelByName", e));
        if(chan) {
          await this.ts3.channelDelete(chan.cid, 1).catch((e) => console.log("channelDelete", e));
        }
        //console.log("creating: id, order ", c.id, c.info.channel_order);
        const name = c.info.channel_name;
        const oldid = c.id;
        filterDictionary(c.info, [
          "pid",
          "channel_topic",
          "channel_description",
          "channel_codec", 
          "channel_codec_quality", 
          "channel_maxclients", 
          "channel_maxfamilyclients", 
          "channel_order", 
          "channel_flag_permanent", 
          "channel_flag_semi_permanent",
          "channel_flag_password",
          "channel_codec_latency_factor",
          "channel_codec_is_unencrypted",
          "channel_flag_maxclients_unlimited",
          "channel_flag_maxfamilyclients_unlimited",
          "channel_flag_maxfamilyclients_inherited",
          "channel_needed_talk_power",
          "channel_forced_silence",
          "channel_name_phonetic"
        ]);
        c.info.channel_order = 0;
        const created = await this.ts3.channelCreate(name, c.info).catch((e) => console.log("channelCreate", e));
        if(created) {
          cids[oldid] = created.cid;
          names[oldid] = created.name;
          if(c.info.pid > 0) {
            await created.move(cids[c.info.pid], cids[c.info.channel_order]).catch((e) => console.log("move", e));
          }
          this.ts3.channelSetPerms(created.cid, c.permissions);
        } else {
          console.log("Could not create channel " + name, c.info);
        }
      } catch(err) {
        console.log("this is bad!", err);
        process.exit();
      }
      this.breath();
    }

    // move channels to appropriate positions
    //for(const c of json) {
    //  let channel = await this.ts3.getChannelByID(cids[c.id]);
    //  if(!channel) {
    //    console.log("ERROR: expected to resolve channel with ID ", cids[c.id], names[c.id]);
    //    continue;
    //  }
    //  let pid = cids[c.info.pid];
    //  if(pid > 0) {
    //    //await channel.move(cids[c.info.pid], c.info.channel_order);  
    //  }      
    //}
  }

  write() {
    console.log("Writing Server Groups");
    fs.readFile(SGROUPS_FILE, (err, data) => tsw.writeServerGroups(JSON.parse(data.toString())));
    console.log("Writing Channels");
    fs.readFile(CHANS_FILE, (err, data) => tsw.writeChannels(JSON.parse(data.toString())));
    console.log("Writing Channels Groups");
    fs.readFile(CGROUPS_FILE, (err, data) => tsw.writeChannelGroups(JSON.parse(data.toString())));
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

  read() {
    console.log("Reading Server Groups")
    this.readServerGroups().then(gs => fs.writeFile(SGROUPS_FILE, JSON.stringify(gs), logerr));
    console.log("Reading Channels")
    this.readChannels().then(cs => fs.writeFile(CHANS_FILE, JSON.stringify(cs), logerr));
    console.log("Reading Client Groups")
    this.readChannelGroups().then(gs => fs.writeFile(CGROUPS_FILE, JSON.stringify(gs), logerr));
  }
}

let logerr = (err) => {
  if(err) {
    return console.log(err);
  }  
};

//let tsr = new TS3Reader(config);
//tsr.on("ready", () => {
//  console.log("Ready");
//  console.log("Reading Server Groups")
//  tsr.readServerGroups().then(gs => fs.writeFile("./sgroups.json", JSON.stringify(gs), logerr));
//  console.log("Reading Channels")
//  tsr.readChannels().then(cs => fs.writeFile("./chans.json", JSON.stringify(cs), logerr));
//  console.log("Reading Client Groups")
//  tsr.readChannelGroups().then(gs => fs.writeFile("./cgroups.json", JSON.stringify(gs), logerr));
//});

let tsw = new TS3Writer(config);
//let tsr = new TS3Reader(config);

async function main(tsw) {
  
  let c = await tsw.ts3.getChannelByName("asd");
  let i = await tsw.ts3.channelInfo(c.cid);
  console.log(i);
  return;  
}



tsw.on("ready", async () => {

  //main(tsw);
  //return
  await tsw.init();
  tsw.write();

  setTimeout(() => { console.log("Logging out due to timeout"); tsw.logout(); }, MAX_RUNTIME);
});