'use client';
import {useEffect,useState} from 'react';
import {useSession} from '@/components/Session';
import {Listicle} from '@/components/Listicle';
import type {PublicPage} from '@/lib/page-data';
export function CampaignPreview({id}:{id:string}){
 const {api}=useSession();const [page,setPage]=useState<PublicPage|null>(null),[error,setError]=useState('');
 useEffect(()=>{let active=true;api<{page:PublicPage|null}>(`/api/campaigns/${id}/preview`).then(r=>{if(active){setPage(r.page);if(!r.page)setError('Your draft page has not been written yet.');}}).catch(e=>{if(active)setError(e.message);});return()=>{active=false;};},[api,id]);
 return page?<><div className="bg-navy p-3 text-center text-sm text-white">Private draft preview · only visible to your account</div><Listicle page={page} preview/></>:<p className="p-10">{error||'Loading your draft…'}</p>;
}
