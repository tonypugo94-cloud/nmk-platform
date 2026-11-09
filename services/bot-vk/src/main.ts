import { runService } from "@nmk/shared";
import { gateway, VkTransport } from "@nmk/bots";
await runService(gateway(new VkTransport({ token: process.env.VK_TOKEN!, secret: process.env.VK_SECRET!, confirmation: process.env.VK_CONFIRMATION! })));
