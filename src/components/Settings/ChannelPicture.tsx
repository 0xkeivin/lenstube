import { LENSHUB_PROXY_ABI } from '@abis/LensHubProxy'
import { useMutation } from '@apollo/client'
import { Loader } from '@components/UIElements/Loader'
import { BROADCAST_MUTATION } from '@gql/queries'
import { CREATE_SET_PROFILE_IMAGE_URI_VIA_DISPATHCER } from '@gql/queries/dispatcher'
import { SET_PFP_URI_TYPED_DATA } from '@gql/queries/typed-data'
import logger from '@lib/logger'
import useAppStore from '@lib/store'
import {
  ERROR_MESSAGE,
  LENSHUB_PROXY_ADDRESS,
  RELAYER_ENABLED
} from '@utils/constants'
import { getCroppedImg } from '@utils/functions/canvasUtils'
import { getFileFromBlob } from '@utils/functions/getFileFromBlob'
import getProfilePicture from '@utils/functions/getProfilePicture'
import omitKey from '@utils/functions/omitKey'
import { sanitizeIpfsUrl } from '@utils/functions/sanitizeIpfsUrl'
import uploadMediaToIPFS from '@utils/functions/uploadToIPFS'
import clsx from 'clsx'
import { utils } from 'ethers'
import React, { ChangeEvent, FC, useCallback, useState } from 'react'
import { Point } from 'react-easy-crop/types'
import toast from 'react-hot-toast'
import { RiImageAddLine } from 'react-icons/ri'
import {
  CreateSetProfileImageUriBroadcastItemResult,
  Profile,
  UpdateProfileImageRequest
} from 'src/types'
import { IPFSUploadResult } from 'src/types/local'
import { useContractWrite, useSignTypedData } from 'wagmi'

import CropModal from './CropModal'

type Props = {
  channel: Profile
}

const ChannelPicture: FC<Props> = ({ channel }) => {
  const [selectedPfp, setSelectedPfp] = useState('')
  const [loading, setLoading] = useState(false)
  const selectedChannel = useAppStore((state) => state.selectedChannel)
  const setSelectedChannel = useAppStore((state) => state.setSelectedChannel)
  const userSigNonce = useAppStore((state) => state.userSigNonce)
  const setUserSigNonce = useAppStore((state) => state.setUserSigNonce)
  const [crop, setCrop] = useState<Point>({ x: 0, y: 0 })
  const [zoom, setZoom] = useState(1)
  const [showModal, setShowModal] = useState(false)
  const [imageSrc, setImageSrc] = useState(null)
  const [croppedAreaPixels, setCroppedAreaPixels] = useState(null)
  const [rotation, setRotation] = useState(0)

  const onError = (error: any) => {
    toast.error(error?.data?.message ?? error?.message ?? ERROR_MESSAGE)
    setLoading(false)
    setSelectedPfp(getProfilePicture(channel, 'avatar_lg'))
  }

  const onCompleted = () => {
    setLoading(false)
    if (selectedChannel && selectedPfp)
      setSelectedChannel({
        ...selectedChannel,
        picture: { original: { url: selectedPfp } }
      })
    toast.success('Channel image updated')
  }

  const { signTypedDataAsync } = useSignTypedData({
    onError
  })

  const { data: pfpData, write: writePfpUri } = useContractWrite({
    address: LENSHUB_PROXY_ADDRESS,
    abi: LENSHUB_PROXY_ABI,
    functionName: 'setProfileImageURIWithSig',
    mode: 'recklesslyUnprepared',
    onError,
    onSuccess: onCompleted
  })

  const [createSetProfileImageViaDispatcher] = useMutation(
    CREATE_SET_PROFILE_IMAGE_URI_VIA_DISPATHCER,
    {
      onError,
      onCompleted
    }
  )

  const [broadcast] = useMutation(BROADCAST_MUTATION, {
    onError,
    onCompleted
  })

  const [createSetProfileImageURITypedData] = useMutation(
    SET_PFP_URI_TYPED_DATA,
    {
      async onCompleted(data) {
        const { typedData, id } =
          data.createSetProfileImageURITypedData as CreateSetProfileImageUriBroadcastItemResult
        try {
          const signature = await signTypedDataAsync({
            domain: omitKey(typedData?.domain, '__typename'),
            types: omitKey(typedData?.types, '__typename'),
            value: omitKey(typedData?.value, '__typename')
          })
          const { profileId, imageURI } = typedData?.value
          const { v, r, s } = utils.splitSignature(signature)
          const args = {
            profileId,
            imageURI,
            sig: { v, r, s, deadline: typedData.value.deadline }
          }
          setUserSigNonce(userSigNonce + 1)
          if (!RELAYER_ENABLED) {
            return writePfpUri?.({ recklesslySetUnpreparedArgs: [args] })
          }
          const { data } = await broadcast({
            variables: { request: { id, signature } }
          })
          if (data?.broadcast?.reason)
            writePfpUri?.({ recklesslySetUnpreparedArgs: [args] })
        } catch (error) {
          setLoading(false)
          logger.error('[Error Set Pfp Typed Data]', error)
        }
      },
      onError
    }
  )

  const signTypedData = (request: UpdateProfileImageRequest) => {
    createSetProfileImageURITypedData({
      variables: { options: { overrideSigNonce: userSigNonce }, request }
    })
  }

  const createViaDispatcher = async (request: UpdateProfileImageRequest) => {
    const { data } = await createSetProfileImageViaDispatcher({
      variables: { request }
    })
    if (!data?.createSetProfileImageURIViaDispatcher?.txId) {
      signTypedData(request)
    }
  }
  function readFile(file: any) {
    return new Promise((resolve) => {
      const reader = new FileReader()
      reader.addEventListener('load', () => resolve(reader.result), false)
      reader.readAsDataURL(file)
    })
  }

  const closeModal = () => {
    setShowModal(false)
    // onClose()
  }

  const onCropComplete = useCallback(
    (croppedArea: any, croppedAreaPixels: any) => {
      setCroppedAreaPixels(croppedAreaPixels)
    },
    []
  )

  const pfpUpload = async (file: File) => {
    if (file) {
      console.log('trying to upload')
      try {
        setLoading(true)
        const result: IPFSUploadResult = await uploadMediaToIPFS(
          // e.target.files[0]
          file
        )
        const request = {
          profileId: selectedChannel?.id,
          url: result.url
        }
        setSelectedPfp(result.url)
        const canUseDispatcher = selectedChannel?.dispatcher?.canUseRelay
        if (!canUseDispatcher) {
          return signTypedData(request)
        }
        await createViaDispatcher(request)
      } catch (error) {
        onError(error)
        logger.error('[Error Pfp Upload]', error)
      }
      return null
    }
  }
  const selectCroppedImage = useCallback(async () => {
    try {
      const croppedImage: any = await getCroppedImg(
        imageSrc,
        croppedAreaPixels,
        rotation
      )
      console.log('done', { croppedImage })
      setSelectedPfp(croppedImage)
      // upload pfp
      const imageFile = getFileFromBlob(croppedImage, 'profilePicture.jpeg')
      console.log('imageFile', imageFile)
      console.log(`${typeof imageFile}`)
      await pfpUpload(imageFile)
      closeModal()
    } catch (e) {
      console.error(e)
    }
  }, [imageSrc, croppedAreaPixels, rotation])

  const onPfpSelect = async (e: ChangeEvent<HTMLInputElement>) => {
    // toggle Modal
    if (e.target.files?.length) {
      try {
        const file = e.target.files[0]
        let imageDataUrl: any = await readFile(file)
        setImageSrc(imageDataUrl)
        setShowModal(true)
        // setSelectedPfp(imageDataUrl)
      } catch (error) {
        onError(error)
        logger.error('[Error Pfp Crop]', error)
      }
    }
  }

  return (
    <div className="relative flex-none overflow-hidden rounded-full group">
      <img
        src={
          selectedPfp
            ? sanitizeIpfsUrl(selectedPfp)
            : getProfilePicture(channel, 'avatar_lg')
        }
        className="object-cover w-32 h-32 border-2 rounded-full"
        draggable={false}
        alt="channel picture"
      />
      <label
        htmlFor="choosePfp"
        className={clsx(
          'absolute top-0 grid w-32 h-32 bg-white rounded-full cursor-pointer bg-opacity-70 place-items-center backdrop-blur-lg invisible group-hover:visible dark:bg-black',
          { '!visible': loading && !pfpData?.hash }
        )}
      >
        {loading && !pfpData?.hash ? (
          <Loader />
        ) : (
          <RiImageAddLine className="text-xl" />
        )}
        <input
          id="choosePfp"
          type="file"
          accept=".png, .jpg, .jpeg, .svg, .gif"
          className="hidden w-full"
          onChange={onPfpSelect}
        />
        <CropModal
          show={showModal}
          setShowCrop={setShowModal}
          zoom={zoom}
          setZoom={setZoom}
          crop={crop}
          setCrop={setCrop}
          onCropComplete={onCropComplete}
          imageSrc={imageSrc}
          rotation={rotation}
          setRotation={setRotation}
          selectCroppedImage={selectCroppedImage}
        />
      </label>
    </div>
  )
}

export default ChannelPicture
