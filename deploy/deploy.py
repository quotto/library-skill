# -*- coding:utf-8 -*-
import zipfile
import os
import configparser
import shutil

DEPLOY_DIR='../deploy' #npm実行場所（src）からの相対パス
BUILD_FILE_PREFIX='skill'
BUILD_FILE_NAME=os.path.join(DEPLOY_DIR,BUILD_FILE_PREFIX+'.zip')
TARGET_SOURCE_DIR='./'

if os.path.exists(BUILD_FILE_NAME):
    os.remove(BUILD_FILE_NAME)

shutil.make_archive(os.path.join(DEPLOY_DIR,BUILD_FILE_PREFIX),'zip',root_dir=TARGET_SOURCE_DIR)

config = configparser.ConfigParser()
config.read(os.path.join(DEPLOY_DIR,'deploy.properties'))

aws_cmd = "aws lambda update-function-code --region " + \
            config['setting']['region'] +" --function-name " + \
            config['setting']['function'] + " --zip-file fileb://" + BUILD_FILE_NAME

os.system(aws_cmd)
