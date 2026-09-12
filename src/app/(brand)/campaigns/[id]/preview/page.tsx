import {Authed} from '@/components/Authed';
import {CampaignPreview} from '@/components/CampaignPreview';
export default async function Preview({params}:{params:Promise<{id:string}>}){const {id}=await params;return <Authed><CampaignPreview id={id}/></Authed>;}
